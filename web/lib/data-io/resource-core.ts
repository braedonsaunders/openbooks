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
import { loadNumberSequenceKindOptions } from '../setup/number-sequence-kinds'
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
  /**
   * The caller's role-derived subsidiary fence; null = organization-wide.
   * The import route always supplies it. Only resources whose descriptor
   * declares `scopedWrite` are reachable by a restricted caller, and they
   * must refuse every row outside this set.
   */
  allowedSubsidiaryIds?: ReadonlySet<string> | null
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
/**
 * Setup `ref` sources that are role-filtered views over parties. The
 * authoritative corpus is the drawer's (see web/lib/setup/ref-options.ts):
 * customers/vendors/employees resolve to parties carrying the matching
 * active role — never to a bare party id from another tenant.
 */
const PARTY_ROLE_TABLE = new Map<string, string>([
  ['customers', 'customer_roles'],
  ['vendors', 'vendor_roles'],
  ['employees', 'employee_roles'],
])

export class RefResolver {
  private toId = new Map<string, string | null>()
  private toLabel = new Map<string, string | null>()
  private sequenceKinds: Promise<Set<string>> | null = null
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
    // Real tables without a setup-registry entry that setup `ref` fields
    // point at (assemblies reference items, billing references projects and
    // customers, entitlement scopes reference employees and trades). Without
    // these, natural keys are unresolvable and UUIDs pass through unchecked.
    if (target.resource === 'items') {
      return { table: 'items', keyCol: 'code', idCol: 'id', orgScoped: true, labelExpr: 'code' }
    }
    if (target.resource === 'projects') {
      return { table: 'projects', keyCol: 'code', idCol: 'id', orgScoped: true, labelExpr: 'code' }
    }
    if (target.resource === 'trades') {
      return { table: 'trades', keyCol: 'name', idCol: 'id', orgScoped: true, labelExpr: 'name' }
    }
    if (target.resource === 'accounting-periods') {
      return { table: 'accounting_periods', keyCol: 'name', idCol: 'id', orgScoped: true, labelExpr: 'name' }
    }
    const entity = SETUP_ENTITY_BY_KEY.get(target.resource)
    if (entity) {
      const keyCol = entity.naturalKey ? toSnake(entity.naturalKey) : idColumn(entity)
      return { table: entity.table, keyCol, idCol: idColumn(entity), orgScoped: entity.orgScoped, labelExpr: keyCol }
    }
    return null
  }

  /**
   * The drawer's number-sequence-kind vocabulary for this org (built-ins plus
   * its custom-record and extension kinds). The stored token IS the key, so
   * resolution is membership, never a table lookup — and a UUID can never be
   * a member.
   */
  private loadSequenceKinds(): Promise<Set<string>> {
    this.sequenceKinds ??= loadNumberSequenceKindOptions(this.orgId).then(
      (options) => new Set(options.map((o) => o.value)),
    )
    return this.sequenceKinds
  }

  /** Natural key (or UUID) → the party carrying the matching active role. */
  private async resolveRolePartyId(roleTable: string, value: string): Promise<string | null> {
    if (UUID_RE.test(value)) {
      const owned = (await db.execute(sql`
        select p.id from parties p
          join ${sql.raw(roleTable)} r on r.party_id = p.id and r.org_id = p.org_id and r.is_active
         where p.id = ${value} and p.org_id = ${this.orgId} limit 1`)) as {
        rows: { id: string }[]
      }
      return owned.rows[0]?.id ?? null
    }
    // Employees also answer to their payroll number; everyone answers to the
    // party code or display name.
    const employeeNumber =
      roleTable === 'employee_roles' ? sql` or er.employee_number = ${value}` : sql``
    const r = (await db.execute(sql`
      select p.id from parties p
        join ${sql.raw(roleTable)} r on r.party_id = p.id and r.org_id = p.org_id and r.is_active
        left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
       where p.org_id = ${this.orgId}
         and (p.short_code = ${value} or p.display_name = ${value}${employeeNumber})
       limit 1`)) as { rows: { id: string }[] }
    return r.rows[0]?.id ?? null
  }

  /** Natural key (or UUID) → the row's UUID. Returns null if not found. */
  async resolveId(target: ResourceRefTarget, human: unknown): Promise<string | null> {
    const value = String(human ?? '').trim()
    if (!value) return null
    if (target.resource === 'number-sequence-kinds') {
      if (UUID_RE.test(value)) return null
      return (await this.loadSequenceKinds()).has(value) ? value : null
    }
    const roleTable = PARTY_ROLE_TABLE.get(target.resource)
    if (roleTable) {
      const cacheKey = `${target.resource}\0${value}`
      if (this.toId.has(cacheKey)) return this.toId.get(cacheKey)!
      const id = await this.resolveRolePartyId(roleTable, value)
      this.toId.set(cacheKey, id)
      return id
    }
    const spec = this.spec(target)
    if (UUID_RE.test(value)) {
      // A UUID is only meaningful inside its owning tenant: an org-scoped
      // target must exist in THIS org, otherwise a file carrying another
      // tenant's id would silently attach to (or create) a foreign row.
      // A target with no registered metadata is refused outright — an
      // unresolvable reference must fail closed, never persist blind. Global
      // targets (e.g. currencies) are shared, but the id must still exist:
      // the org predicate is omitted, never the lookup.
      if (!spec) return null
      const uuidCacheKey = `${target.resource}\0${value}`
      if (this.toId.has(uuidCacheKey)) return this.toId.get(uuidCacheKey)!
      const tenantFilter = spec.orgScoped ? sql` and org_id = ${this.orgId}` : sql``
      const owned = (await db.execute(sql`
        select ${sql.raw(spec.idCol)} as id from ${sql.raw(spec.table)}
         where ${sql.raw(spec.idCol)} = ${value}${tenantFilter} limit 1`)) as {
        rows: { id: string }[]
      }
      const ownedId = owned.rows[0]?.id ?? null
      this.toId.set(uuidCacheKey, ownedId)
      return ownedId
    }
    if (!spec) return null
    const cacheKey = `${target.resource}\0${value}`
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
    // A sequence-kind token is already its own label.
    if (target.resource === 'number-sequence-kinds') return uuid
    // Role-filtered views label like the underlying party; ownership (not
    // role liveness) is the export boundary so historical rows keep names.
    const labelTarget = PARTY_ROLE_TABLE.has(target.resource)
      ? { resource: 'parties', by: 'short_code' }
      : target
    const spec = this.spec(labelTarget)
    if (!spec) return uuid
    const cacheKey = `${target.resource}\0${uuid}`
    if (this.toLabel.has(cacheKey)) return this.toLabel.get(cacheKey) ?? uuid
    // Labels are tenant data too: never render another org's natural key into
    // this org's export. A foreign or deleted id falls back to the UUID.
    const labelOrgFilter = spec.orgScoped ? sql` and org_id = ${this.orgId}` : sql``
    const r = (await db.execute(sql`
      select ${sql.raw(spec.labelExpr)} as label from ${sql.raw(spec.table)}
       where ${sql.raw(spec.idCol)} = ${uuid}${labelOrgFilter} limit 1`)) as { rows: { label: string | null }[] }
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
