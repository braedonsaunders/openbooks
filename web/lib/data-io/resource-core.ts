/**
 * Shared kernel for the data-io resource modules: the DataResource contract,
 * natural-key <-> UUID reference resolution (RefResolver), export cell
 * formatting, the org-level feature gate every resource family reads, and the
 * shared export row cap.
 */


import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { featureEnabled, resolvedFeatureState } from '../features'
import { SETUP_ENTITY_BY_KEY, toSnake } from '../setup/registry'
import { coerceBoolean, idColumn, UUID_RE } from '../setup/coerce'
import {
  type CellValue,
  type ImportMode,
  type ResourceDescriptor,
  type ResourceField,
  type ResourceRefTarget,
  type WriteOutcome,
} from './types'
export const MAX_EXPORT_ROWS = 50_000
export interface ReadResult {
  fields: ResourceField[]
  /** Ordered export columns (may include keys not in `fields`, e.g. record_number). */
  columns: { key: string; label: string }[]
  rows: Record<string, CellValue>[]
}

/**
 * Visibility context for a resource read. `null` means the caller has no
 * subsidiary restriction; a non-null set is the role-derived allow-list. The
 * context is deliberately part of the resource contract so a generic route
 * cannot accidentally fall back to an org-only read.
 */
export interface ReadCtx {
  allowedSubsidiaryIds: ReadonlySet<string> | null
}

export interface WriteCtx {
  orgId: string
  actorId: string
  /** Dry-run: validate + classify insert/update, but write nothing. */
  dryRun: boolean
  /** Transactions only: post to the ledger after creating the draft. */
  post?: boolean
}

export interface DataResource {
  descriptor: ResourceDescriptor
  /** Import target fields (what a file column can map onto). */
  fields(): Promise<ResourceField[]>
  /** Ordered export columns (cheap — no data query). */
  columns(): Promise<{ key: string; label: string }[]>
  read(ctx?: ReadCtx): Promise<ReadResult>
  write(rows: Record<string, unknown>[], mode: ImportMode, ctx: WriteCtx): Promise<WriteOutcome>
}

/**
 * SQL predicate shared by resource adapters whose source table carries a
 * subsidiary_id. IDs are resolved from the authorization layer, not request
 * input; an empty allow-list still fails closed rather than becoming an
 * unscoped query.
 */
export function subsidiaryReadFilter(
  column: SQL,
  allowed: ReadonlySet<string> | null | undefined,
): SQL {
  if (allowed === null || allowed === undefined) return sql``
  const ids = [...allowed]
  if (ids.length === 0) return sql` and false`
  return sql` and ${column} = any(${`{${ids.join(',')}}`}::uuid[])`
}
// --- Reference resolution -----------------------------------------------------

/**
 * Human value ⇄ UUID for a reference target. Imports let users name a target by
 * its natural key (account number, tax code) instead of a UUID; exports emit
 * that same natural key. A per-instance cache dedupes repeated lookups.
 */
export class RefResolver {
  private toId = new Map<string, string | null>()
  private toLabel = new Map<string, string | null>()
  constructor(private orgId: string) {}

  private spec(target: ResourceRefTarget):
    | { table: string; keyCol: string; idCol: string; orgScoped: boolean; labelExpr: string }
    | null {
    if (target.resource === 'accounts') {
      return { table: 'accounts', keyCol: 'number', idCol: 'id', orgScoped: true, labelExpr: 'number' }
    }
    if (target.resource === 'parties') {
      return {
        table: 'parties',
        keyCol: 'short_code',
        idCol: 'id',
        orgScoped: true,
        labelExpr: 'coalesce(short_code, display_name)',
      }
    }
    const entity = SETUP_ENTITY_BY_KEY.get(target.resource)
    if (entity) {
      const keyCol = entity.naturalKey ? toSnake(entity.naturalKey) : idColumn(entity)
      return { table: entity.table, keyCol, idCol: idColumn(entity), orgScoped: entity.orgScoped, labelExpr: keyCol }
    }
    return null
  }

  /** Natural key (or UUID) → the row's UUID. Returns null if not found. */
  async resolveId(target: ResourceRefTarget, human: unknown): Promise<string | null> {
    const value = String(human ?? '').trim()
    if (!value) return null
    if (UUID_RE.test(value)) return value
    const spec = this.spec(target)
    if (!spec) return null
    const cacheKey = `${target.resource}\u0000${value}`
    if (this.toId.has(cacheKey)) return this.toId.get(cacheKey)!
    const orgFilter = spec.orgScoped ? sql` and org_id = ${this.orgId}` : sql``
    let r = (await db.execute(sql`
      select ${sql.raw(spec.idCol)} as id from ${sql.raw(spec.table)}
       where ${sql.raw(spec.keyCol)} = ${value}${orgFilter} limit 1`)) as { rows: { id: string }[] }
    if (r.rows.length === 0 && target.resource === 'parties') {
      r = (await db.execute(sql`
        select id from parties where display_name = ${value} and org_id = ${this.orgId} limit 1`)) as {
        rows: { id: string }[]
      }
    }
    const id = r.rows[0]?.id ?? null
    this.toId.set(cacheKey, id)
    return id
  }

  /** UUID → the human natural key (for export). Falls back to the UUID. */
  async resolveLabel(target: ResourceRefTarget, id: unknown): Promise<string> {
    const uuid = String(id ?? '').trim()
    if (!uuid) return ''
    const spec = this.spec(target)
    if (!spec) return uuid
    const cacheKey = `${target.resource}\u0000${uuid}`
    if (this.toLabel.has(cacheKey)) return this.toLabel.get(cacheKey) ?? uuid
    const r = (await db.execute(sql`
      select ${sql.raw(spec.labelExpr)} as label from ${sql.raw(spec.table)}
       where ${sql.raw(spec.idCol)} = ${uuid} limit 1`)) as { rows: { label: string | null }[] }
    const label = r.rows[0]?.label ?? null
    this.toLabel.set(cacheKey, label)
    return label ?? uuid
  }
}

/** Format one stored value for export, resolving references to natural keys. */
export async function exportCell(field: ResourceField, v: unknown, resolver: RefResolver): Promise<CellValue> {
  if (v === null || v === undefined) return null
  if (field.kind === 'reference' && field.ref) return resolver.resolveLabel(field.ref, v)
  if (field.kind === 'boolean') return coerceBoolean(v)
  if (field.kind === 'multiselect') return Array.isArray(v) ? v.join(', ') : String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
}
/** One org-level feature gate, read from the Company Settings switchboard. */
export async function orgFeatureEnabled(orgId: string, featureKey: string): Promise<boolean> {
  return featureEnabled(await resolvedFeatureState(orgId), featureKey)
}
