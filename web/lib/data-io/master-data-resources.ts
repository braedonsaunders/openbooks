/** Master-data (accounts, items, parties) import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { toSnake } from '../setup/registry'
import { coerceBoolean } from '../setup/coerce'
import { loadFieldDefs, validateCustomValues, type CustomFieldDef } from '../custom-fields'
import {
  exportCell,
  MAX_EXPORT_ROWS,
  orgFeatureEnabled,
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
// --- Master-data resources ----------------------------------------------------

interface MasterCol {
  key: string
  column: string
  kind: ResourceField['kind']
  required?: boolean
  options?: { value: string; label: string }[]
  ref?: ResourceRefTarget
  lockedOnEdit?: boolean
}

interface MasterEntity {
  key: string
  table: string
  iconKey: string
  naturalKey: string
  /** custom_field_defs target table (for the `custom` jsonb extension). */
  customTarget: string
  readPermission: string
  writePermission: string
  cols: MasterCol[]
}

const ACCOUNT_TYPE_OPTS = [
  'asset_bank', 'asset_receivable', 'asset_current_other', 'asset_fixed', 'asset_other',
  'liability_payable', 'liability_card', 'liability_current_other', 'liability_long_term',
  'equity', 'income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred',
].map((v) => ({ value: v, label: v }))

const ITEM_KIND_OPTS = [
  'service', 'non_inventory', 'inventory', 'assembly', 'kit', 'other_charge', 'equipment_charge', 'labor', 'absence', 'discount',
].map((v) => ({ value: v, label: v }))

export const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

const ITEM_EQUIPMENT_KINDS = new Set(['equipment_charge'])

export const MASTER_ENTITIES: MasterEntity[] = [
  {
    key: 'accounts',
    table: 'accounts',
    iconKey: 'landmark',
    naturalKey: 'number',
    customTarget: 'accounts',
    readPermission: 'gl.read',
    writePermission: 'admin.setup.manage',
    cols: [
      { key: 'number', column: 'number', kind: 'text', lockedOnEdit: true },
      { key: 'name', column: 'name', kind: 'text', required: true },
      { key: 'type', column: 'type', kind: 'select', required: true, options: ACCOUNT_TYPE_OPTS },
      { key: 'description', column: 'description', kind: 'text' },
      { key: 'parentNumber', column: 'parent_id', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
      { key: 'isSummary', column: 'is_summary', kind: 'boolean' },
      { key: 'reconcilable', column: 'reconcilable', kind: 'boolean' },
      { key: 'currencyRestriction', column: 'currency_restriction', kind: 'text' },
      { key: 'isActive', column: 'is_active', kind: 'boolean' },
    ],
  },
  {
    key: 'items',
    table: 'items',
    iconKey: 'package',
    naturalKey: 'code',
    customTarget: 'items',
    readPermission: 'items.read',
    writePermission: 'items.manage',
    cols: [
      { key: 'code', column: 'code', kind: 'text', lockedOnEdit: true },
      { key: 'name', column: 'name', kind: 'text', required: true },
      { key: 'kind', column: 'kind', kind: 'select', required: true, options: ITEM_KIND_OPTS },
      { key: 'category', column: 'category', kind: 'text' },
      { key: 'incomeAccount', column: 'income_account_id', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
      { key: 'expenseAccount', column: 'expense_account_id', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
      { key: 'defaultRate', column: 'default_rate', kind: 'currency' },
      { key: 'unit', column: 'unit', kind: 'text' },
      { key: 'taxCode', column: 'tax_code_id', kind: 'reference', ref: { resource: 'tax-codes', by: 'code' } },
      { key: 'showOnTimesheet', column: 'show_on_timesheet', kind: 'boolean' },
      { key: 'isActive', column: 'is_active', kind: 'boolean' },
    ],
  },
  {
    key: 'parties',
    table: 'parties',
    iconKey: 'users',
    naturalKey: 'shortCode',
    customTarget: 'parties',
    readPermission: 'parties.read',
    writePermission: 'parties.manage',
    cols: [
      { key: 'shortCode', column: 'short_code', kind: 'text', lockedOnEdit: true },
      { key: 'displayName', column: 'display_name', kind: 'text', required: true },
      { key: 'kind', column: 'kind', kind: 'select', required: true, options: [
        { value: 'company', label: 'company' }, { value: 'person', label: 'person' }] },
      { key: 'legalName', column: 'legal_name', kind: 'text' },
      { key: 'email', column: 'email', kind: 'text' },
      { key: 'phone', column: 'phone', kind: 'text' },
      { key: 'website', column: 'website', kind: 'text' },
      { key: 'isActive', column: 'is_active', kind: 'boolean' },
    ],
  },
]

export const MASTER_BY_KEY = new Map(MASTER_ENTITIES.map((m) => [m.key, m]))

async function masterFields(m: MasterEntity, orgId: string): Promise<ResourceField[]> {
  const timeTrackingOn = m.key !== 'items' || (await orgFeatureEnabled(orgId, 'timeTracking'))
  const inventoryOn = m.key !== 'items' || (await orgFeatureEnabled(orgId, 'inventory'))
  const equipmentOn = m.key !== 'items' || (await orgFeatureEnabled(orgId, 'equipment'))
  const multiCurrencyOn = m.key !== 'accounts' || (await orgFeatureEnabled(orgId, 'multiCurrency'))
  const core: ResourceField[] = m.cols
    .filter((c) => timeTrackingOn || c.key !== 'showOnTimesheet')
    .filter((c) => multiCurrencyOn || c.key !== 'currencyRestriction')
    .map((c) => ({
      key: c.key,
      label: c.key,
      kind: c.kind,
      required: c.required,
      options: c.key === 'kind' && !inventoryOn
        ? c.options?.filter((o) => !INVENTORY_ITEM_KINDS.has(o.value) && (equipmentOn || !ITEM_EQUIPMENT_KINDS.has(o.value)))
        : c.key === 'kind' && !equipmentOn
          ? c.options?.filter((o) => !ITEM_EQUIPMENT_KINDS.has(o.value))
          : c.options,
      ref: c.ref,
    }))
  const defs = await loadFieldDefs(m.customTarget)
  const custom: ResourceField[] = defs.map((d) => customFieldToResource(d))
  return [...core, ...custom]
}

function customFieldToResource(d: CustomFieldDef): ResourceField {
  const kindMap: Record<CustomFieldDef['fieldType'], ResourceField['kind']> = {
    text: 'text',
    long_text: 'long_text',
    number: 'number',
    currency: 'currency',
    date: 'date',
    boolean: 'boolean',
    select: 'select',
    multi_select: 'multiselect',
    reference: 'reference',
  }
  return {
    key: d.key,
    label: d.label,
    kind: kindMap[d.fieldType],
    required: d.isRequired,
    options: d.config.options?.map((o) => ({ value: o, label: o })),
    ref: d.config.referenceTable ? { resource: d.config.referenceTable, by: 'id' } : undefined,
    custom: true,
  }
}

export function masterDescriptor(m: MasterEntity): ResourceDescriptor {
  return {
    key: m.key,
    label: m.key,
    group: 'Master data',
    iconKey: m.iconKey,
    readPermission: m.readPermission,
    writePermission: m.writePermission,
    supportsImport: true,
    naturalKey: m.naturalKey,
  }
}

export function masterResource(m: MasterEntity, orgId: string): DataResource {
  return {
    descriptor: masterDescriptor(m),
    fields: () => masterFields(m, orgId),
    async columns() {
      return (await masterFields(m, orgId)).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const fields = await masterFields(m, orgId)
      const resolver = new RefResolver(orgId)
      const exportCols = m.cols.filter((c) => fields.some((f) => f.key === c.key))
      const coreCols = exportCols.map((c) => sql.raw(c.column))
      const result = (await db.execute(sql`
        select ${sql.join(coreCols, sql`, `)}, custom
          from ${sql.raw(m.table)}
         where org_id = ${orgId}
         order by ${sql.raw(m.naturalKey === 'shortCode' ? 'display_name' : m.cols[0]!.column)}
         limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, unknown>[] }
      const customDefs = fields.filter((f) => f.custom)
      const out: Record<string, CellValue>[] = []
      for (const raw of result.rows) {
        const row: Record<string, CellValue> = {}
        for (const c of exportCols) {
          const f = fields.find((x) => x.key === c.key)!
          row[c.key] = await exportCell(f, raw[c.column], resolver)
        }
        const custom = (raw.custom ?? {}) as Record<string, unknown>
        for (const f of customDefs) row[f.key] = await exportCell(f, custom[f.key], resolver)
        out.push(row)
      }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: out }
    },
    async write(rows, mode, ctx) {
      return writeMaster(m, rows, mode, ctx)
    },
  }
}

async function writeMaster(
  m: MasterEntity,
  rows: Record<string, unknown>[],
  mode: ImportMode,
  ctx: WriteCtx,
): Promise<WriteOutcome> {
  const resolver = new RefResolver(ctx.orgId)
  const defs = await loadFieldDefs(m.customTarget)
  const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
  const nkColumn = m.cols.find((c) => c.key === m.naturalKey)?.column ?? toSnake(m.naturalKey)
  const timeTrackingOn = m.key !== 'items' || (await orgFeatureEnabled(ctx.orgId, 'timeTracking'))
  const inventoryOn = m.key !== 'items' || (await orgFeatureEnabled(ctx.orgId, 'inventory'))
  const equipmentOn = m.key !== 'items' || (await orgFeatureEnabled(ctx.orgId, 'equipment'))
  const multiCurrencyOn = m.key !== 'accounts' || (await orgFeatureEnabled(ctx.orgId, 'multiCurrency'))

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 1
    const src = rows[i]!
    try {
      // Coerce core columns.
      const setCols: { column: string; value: unknown }[] = []
      let err: string | null = null
      for (const c of m.cols) {
        if (c.key === 'showOnTimesheet' && !timeTrackingOn) {
          if (src.showOnTimesheet !== undefined) {
            err = 'showOnTimesheet is not available'
            break
          }
          continue
        }
        if (c.key === 'currencyRestriction' && !multiCurrencyOn) {
          if (src.currencyRestriction !== undefined) {
            err = 'currencyRestriction is not available'
            break
          }
          continue
        }
        const raw = src[c.key]
        const present = raw !== undefined && raw !== null && raw !== ''
        if (c.required && !present && c.kind !== 'boolean') {
          err = `${c.key} is required`
          break
        }
        if (c.kind === 'boolean') {
          setCols.push({ column: c.column, value: coerceBoolean(raw) })
          continue
        }
        if (!present) continue
        if (c.kind === 'reference' && c.ref) {
          const id = await resolver.resolveId(c.ref, raw)
          if (!id) {
            err = `${c.key}: "${String(raw)}" not found`
            break
          }
          setCols.push({ column: c.column, value: id })
          continue
        }
        if (c.kind === 'select' && c.options && !c.options.some((o) => o.value === String(raw))) {
          err = `${c.key}: invalid value "${String(raw)}"`
          break
        }
        if ((c.kind === 'number' || c.kind === 'currency' || c.kind === 'percent') && !Number.isFinite(Number(raw))) {
          err = `${c.key} must be a number`
          break
        }
        setCols.push({ column: c.column, value: c.kind === 'currency' ? String(raw) : raw })
      }
      if (err) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: err })
        continue
      }

      // Custom fields → validated `custom` jsonb.
      const customInput: Record<string, unknown> = {}
      for (const d of defs) if (src[d.key] !== undefined) customInput[d.key] = src[d.key]
      const cv = validateCustomValues(defs, customInput)
      if (!cv.ok) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: Object.values(cv.errors).join('; ') })
        continue
      }

      const nkVal = String(src[m.naturalKey] ?? '').trim()
      let existingId: string | null = null
      let existingCustom: Record<string, unknown> = {}
      let storedKind: string | undefined
      if (nkVal) {
        const found = (await db.execute(sql`
          select id, custom${m.key === 'items' ? sql`, kind` : sql``} from ${sql.raw(m.table)}
           where ${sql.raw(nkColumn)} = ${nkVal} and org_id = ${ctx.orgId} limit 1`)) as {
          rows: { id: string; custom: Record<string, unknown>; kind?: string }[]
        }
        existingId = found.rows[0]?.id ?? null
        existingCustom = found.rows[0]?.custom ?? {}
        storedKind = found.rows[0]?.kind
      }

      // Inventory kinds (inventory / assembly / kit) are Inventory configuration.
      // Turning that switch off must refuse a new write; the stored kind stays.
      if (m.key === 'items' && !inventoryOn) {
        const kindCol = setCols.find((c) => c.column === 'kind')
        if (kindCol) {
          const nextKind = String(kindCol.value)
          if (
            (INVENTORY_ITEM_KINDS.has(nextKind) && nextKind !== storedKind) ||
            (storedKind !== undefined && INVENTORY_ITEM_KINDS.has(storedKind) && nextKind !== storedKind)
          ) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: 'kind is not available' })
            continue
          }
          if (INVENTORY_ITEM_KINDS.has(nextKind) && nextKind === storedKind) {
            setCols.splice(setCols.indexOf(kindCol), 1)
          }
        }
      }

      // Equipment-charge kind is Equipment configuration.
      // Turning that switch off must refuse a new write; the stored kind stays.
      if (m.key === 'items' && !equipmentOn) {
        const kindCol = setCols.find((c) => c.column === 'kind')
        if (kindCol) {
          const nextKind = String(kindCol.value)
          if (
            (ITEM_EQUIPMENT_KINDS.has(nextKind) && nextKind !== storedKind) ||
            (storedKind !== undefined && ITEM_EQUIPMENT_KINDS.has(storedKind) && nextKind !== storedKind)
          ) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: 'kind is not available' })
            continue
          }
          if (ITEM_EQUIPMENT_KINDS.has(nextKind) && nextKind === storedKind) {
            setCols.splice(setCols.indexOf(kindCol), 1)
          }
        }
      }

      if (existingId && mode === 'insert') {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `already exists (${m.naturalKey}=${nkVal})` })
        continue
      }

      const mergedCustom = { ...existingCustom, ...cv.cleaned }
      if (existingId) {
        if (!ctx.dryRun) {
          const parts = setCols
            .filter((c) => c.column !== nkColumn) // don't rewrite the natural key
            .map((c) => sql`${sql.raw(c.column)} = ${c.value}`)
          parts.push(sql`custom = ${JSON.stringify(mergedCustom)}::jsonb`)
          parts.push(sql`updated_by = ${ctx.actorId}`)
          parts.push(sql`updated_at = now()`)
          await db.execute(sql`
            update ${sql.raw(m.table)} set ${sql.join(parts, sql`, `)}
             where id = ${existingId} and org_id = ${ctx.orgId}`)
          await auditRaw(m.table, existingId, 'update', ctx)
        }
        outcome.updated++
      } else {
        if (!ctx.dryRun) {
          const cols = [
            ...setCols,
            { column: 'org_id', value: ctx.orgId },
            { column: 'created_by', value: ctx.actorId },
            { column: 'updated_by', value: ctx.actorId },
          ]
          const names = sql.raw([...cols.map((c) => c.column), 'custom'].join(', '))
          const values = sql.join(
            [...cols.map((c) => sql`${c.value}`), sql`${JSON.stringify(mergedCustom)}::jsonb`],
            sql`, `,
          )
          const ins = (await db.execute(sql`
            insert into ${sql.raw(m.table)} (${names}) values (${values}) returning id`)) as {
            rows: { id: string }[]
          }
          await auditRaw(m.table, String(ins.rows[0]?.id ?? ''), 'insert', ctx)
        }
        outcome.created++
      }
    } catch (e) {
      outcome.failed++
      outcome.errors.push({ row: rowNo, message: (e as { message?: string })?.message ?? 'write failed' })
    }
  }
  return outcome
}

async function auditRaw(table: string, rowId: string, action: 'insert' | 'update', ctx: WriteCtx) {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${ctx.orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify({ source: 'import' })}, ${ctx.actorId})`)
}
