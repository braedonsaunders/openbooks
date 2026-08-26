/** Setup-registry import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { COUNTRY_CODES } from '../countries'
import { featureEnabled, resolvedFeatureState } from '../features'
import { SETUP_ENTITY_BY_KEY, setupEntityForFeatureState, toSnake, type SetupEntity, type SetupField } from '../setup/registry'
import { buildRow, idColumn } from '../setup/coerce'
import {
  exportCell,
  MAX_EXPORT_ROWS,
  RefResolver,
  type DataResource,
  type WriteCtx,
} from './resource-core'
import {
  type CellValue,
  type ImportMode,
  type ResourceDescriptor,
  type ResourceField,
  type ResourceRefTarget,
  type WriteOutcome,
} from './types'
// --- Setup-registry resources -------------------------------------------------

const SETUP_KIND_MAP: Record<SetupField['kind'], ResourceField['kind']> = {
  text: 'text',
  country: 'select',
  textarea: 'long_text',
  integer: 'number',
  decimal: 'number',
  percent: 'percent',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
  ref: 'reference',
  multiref: 'multiselect',
  json: 'long_text',
  // jsonb text[] — round-trips as its JSON text (export stringifies, the
  // shared coercer parses it back); the drawer-side TagInput is UI-only.
  stringArray: 'long_text',
}

function refNaturalKey(ref: string): string {
  if (ref === 'accounts') return 'number'
  const entity = SETUP_ENTITY_BY_KEY.get(ref)
  return entity?.naturalKey ?? 'id'
}

function setupFields(entity: SetupEntity): ResourceField[] {
  return entity.fields
    .filter((f) => f.kind !== 'multiref') // join-table fields aren't bulk-importable yet
    .map((f) => ({
      key: f.key,
      label: f.key,
      kind: SETUP_KIND_MAP[f.kind],
      required: f.required,
      options: f.kind === 'country'
        ? COUNTRY_CODES.map((code) => ({ value: code, label: code }))
        : f.options?.map((o) => ({ value: o.value, label: o.value })),
      // Only true reference fields resolve natural keys → ids on import. A
      // stringArray's `ref` is merely its type-ahead corpus — the values ARE
      // the stored strings.
      ref: f.kind === 'ref' && f.ref ? { resource: f.ref, by: refNaturalKey(f.ref) } : undefined,
    }))
}

export function setupDescriptor(entity: SetupEntity): ResourceDescriptor {
  return {
    key: entity.key,
    label: entity.key,
    group: 'Setup',
    iconKey: entity.iconKey || 'sliders',
    readPermission: 'admin.setup.manage',
    writePermission: 'admin.setup.manage',
    supportsImport: true,
    naturalKey: entity.naturalKey,
  }
}

async function gatedSetupEntity(entity: SetupEntity, orgId: string): Promise<SetupEntity> {
  const features = await resolvedFeatureState(orgId)
  return setupEntityForFeatureState(entity, {
    multiSubsidiary: featureEnabled(features, 'multiSubsidiary'),
    equipment: featureEnabled(features, 'equipment'),
    fieldTickets: featureEnabled(features, 'fieldTickets'),
  })
}

export function setupResource(entity: SetupEntity, orgId: string): DataResource {
  return {
    descriptor: setupDescriptor(entity),
    async fields() {
      return setupFields(await gatedSetupEntity(entity, orgId))
    },
    async columns() {
      return setupFields(await gatedSetupEntity(entity, orgId)).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const fields = setupFields(await gatedSetupEntity(entity, orgId))
      const resolver = new RefResolver(orgId)
      const cols = fields.map((f) => sql.raw(toSnake(f.key)))
      const result = (await db.execute(sql`
        select ${sql.join(cols, sql`, `)}
          from ${sql.raw(entity.table)}
         ${entity.orgScoped ? sql`where org_id = ${orgId}` : sql``}
         order by ${sql.raw(idColumn(entity))}
         limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, unknown>[] }
      const out: Record<string, CellValue>[] = []
      for (const raw of result.rows) {
        const row: Record<string, CellValue> = {}
        for (const f of fields) row[f.key] = await exportCell(f, raw[toSnake(f.key)], resolver)
        out.push(row)
      }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: out }
    },
    async write(rows, mode, ctx) {
      return writeSetup(await gatedSetupEntity(entity, ctx.orgId), rows, mode, ctx)
    },
  }
}

/**
 * Bulk insert/upsert into a Setup-registry table. Mirrors the interactive
 * route (api/admin/setup/[entity]): coerce via the shared registry validator,
 * resolve reference columns from natural keys, match update-vs-insert by the
 * entity's natural key, stamp org/actor columns, and audit every write.
 */
async function writeSetup(
  entity: SetupEntity,
  rows: Record<string, unknown>[],
  mode: ImportMode,
  ctx: WriteCtx,
): Promise<WriteOutcome> {
  const resolver = new RefResolver(ctx.orgId)
  const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
  const refFields = entity.fields.filter((f) => f.kind === 'ref')

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 1
    const src = { ...rows[i] }
    try {
      if (src.showOnFieldTicket !== undefined && !entity.fields.some((field) => field.key === 'showOnFieldTicket')) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: 'showOnFieldTicket is not available' })
        continue
      }

      // Resolve reference columns (natural key → uuid) before coercion.
      let refError: string | null = null
      for (const rf of refFields) {
        const human = src[rf.key]
        if (human === undefined || human === null || human === '') continue
        const target: ResourceRefTarget = { resource: rf.ref!, by: refNaturalKey(rf.ref!) }
        const id = await resolver.resolveId(target, human)
        if (!id) {
          refError = `${rf.key}: "${String(human)}" not found`
          break
        }
        src[rf.key] = id
      }
      if (refError) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: refError })
        continue
      }

      // Does a row with this natural key already exist?
      let existingId: string | null = null
      if (entity.naturalKey) {
        const nkVal = String(src[entity.naturalKey] ?? '').trim()
        if (nkVal) {
          const orgFilter = entity.orgScoped ? sql` and org_id = ${ctx.orgId}` : sql``
          const dup = (await db.execute(sql`
            select ${sql.raw(idColumn(entity))} as id from ${sql.raw(entity.table)}
             where ${sql.raw(toSnake(entity.naturalKey))} = ${nkVal}${orgFilter} limit 1`)) as {
            rows: { id: string }[]
          }
          existingId = dup.rows[0]?.id ?? null
        }
      }

      if (existingId && mode === 'insert') {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `already exists (${entity.naturalKey}=${String(src[entity.naturalKey!])})` })
        continue
      }

      if (existingId) {
        const built = buildRow(entity, src, { forCreate: false })
        if ('error' in built) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: built.error })
          continue
        }
        if (!ctx.dryRun) {
          const setParts = built.cols.map((c) => sql`${sql.raw(c.column)} = ${c.value}`)
          if (entity.actorCols) {
            setParts.push(sql`updated_by = ${ctx.actorId}`)
            setParts.push(sql`updated_at = now()`)
          }
          if (setParts.length > 0) {
            const orgFilter = entity.orgScoped ? sql` and org_id = ${ctx.orgId}` : sql``
            await db.execute(sql`
              update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
               where ${sql.raw(idColumn(entity))} = ${existingId}${orgFilter}`)
            await audit(entity, existingId, 'update', ctx)
          }
        }
        outcome.updated++
      } else {
        const built = buildRow(entity, src, { forCreate: true })
        if ('error' in built) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: built.error })
          continue
        }
        if (!ctx.dryRun) {
          const cols = [...built.cols]
          if (entity.orgScoped) cols.push({ column: 'org_id', value: ctx.orgId })
          if (entity.actorCols) {
            cols.push({ column: 'created_by', value: ctx.actorId })
            cols.push({ column: 'updated_by', value: ctx.actorId })
          }
          const colSql = sql.raw(cols.map((c) => c.column).join(', '))
          const valSql = sql.join(cols.map((c) => sql`${c.value}`), sql`, `)
          const ins = (await db.execute(sql`
            insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
            returning ${sql.raw(idColumn(entity))} as id`)) as { rows: { id: string }[] }
          await audit(entity, String(ins.rows[0]?.id ?? ''), 'insert', ctx)
        }
        outcome.created++
      }
    } catch (e) {
      outcome.failed++
      // Drizzle wraps the driver error, so the storage guard's message lives
      // on `cause` — surface that, never the wrapper's query echo.
      const cause = (e as { cause?: { message?: string } })?.cause
      outcome.errors.push({ row: rowNo, message: cause?.message ?? (e as { message?: string })?.message ?? 'write failed' })
    }
  }
  return outcome
}

async function audit(entity: SetupEntity, rowId: string, action: 'insert' | 'update', ctx: WriteCtx) {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${entity.orgScoped ? ctx.orgId : null}, ${entity.table}, ${rowId}, ${action},
            ${JSON.stringify({ source: 'import' })}, ${ctx.actorId})`)
}
