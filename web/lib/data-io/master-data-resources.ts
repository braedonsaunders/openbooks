/** Master-data (accounts, items, parties) import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from '../exact-decimal'
import { assetBankHygieneWarning } from '../accounts-hygiene'
import { toSnake } from '../setup/registry'
import { coerceBoolean, UUID_RE } from '../setup/coerce'
import { loadFieldDefs, validateCustomValues, type CustomFieldDef } from '../custom-fields'
import {
  enforceExportRowLimit,
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
      { key: 'number', column: 'number', kind: 'text', required: true, lockedOnEdit: true },
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
      // parties.kind is unconstrained text and the product stores
      // role-denormalized values (customer/vendor/employee) that export
      // emits — the importer must accept the vocabulary export produces,
      // or no exported parties file re-imports.
      { key: 'kind', column: 'kind', kind: 'select', required: true, options: [
        { value: 'company', label: 'company' }, { value: 'person', label: 'person' },
        { value: 'customer', label: 'customer' }, { value: 'vendor', label: 'vendor' },
        { value: 'employee', label: 'employee' }] },
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

/**
 * RefResolver intentionally accepts a syntactically valid UUID without a
 * lookup. That is useful for shared resources, but account references are
 * tenant-owned and must never cross that boundary. Re-check direct UUIDs in
 * the importing org before persisting them.
 */
async function resolveMasterRefId(
  resolver: RefResolver,
  target: ResourceRefTarget,
  human: unknown,
  orgId: string,
): Promise<string | null> {
  const id = await resolver.resolveId(target, human)
  if (!id) return null

  const value = String(human ?? '').trim()
  if (target.resource !== 'accounts' || !UUID_RE.test(value)) return id

  const owned = (await db.execute(sql`
    select id from accounts
     where id = ${id} and org_id = ${orgId}
     limit 1`)) as { rows: { id: string }[] }
  return owned.rows[0]?.id ?? null
}

/**
 * Account labels are also tenant data. Avoid RefResolver's unscoped UUID label
 * lookup when exporting legacy rows that may contain a foreign account id.
 */
async function exportMasterCell(
  field: ResourceField,
  value: unknown,
  resolver: RefResolver,
  orgId: string,
): Promise<CellValue> {
  if (field.kind === 'reference' && field.ref?.resource === 'accounts') {
    const id = String(value ?? '').trim()
    if (UUID_RE.test(id)) {
      const owned = (await db.execute(sql`
        select number as label from accounts
         where id = ${id} and org_id = ${orgId}
         limit 1`)) as { rows: { label: string | null }[] }
      return owned.rows[0]?.label ?? id
    }
  }
  return exportCell(field, value, resolver)
}

/**
 * Keep a master-data mutation and its mandatory audit evidence in the same
 * transaction. The savepoint makes this safe when the import route already
 * owns an outer transaction: a failed audit row rolls back just this row,
 * allowing the caller to report the row failure without leaving the outer
 * transaction aborted.
 */
async function persistMasterMutation(
  table: string,
  action: 'insert' | 'update',
  ctx: WriteCtx,
  before: Record<string, unknown> | null,
  mutate: (tx: SqlExecutor) => Promise<{ rowId: string; after: Record<string, unknown> | null }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`savepoint master_import_row`)
    try {
      const { rowId, after } = await mutate(tx)
      if (!rowId) throw new Error('master-data mutation did not return an id')
      await auditRow(tx, table, rowId, action, ctx, before, after)
      await tx.execute(sql`release savepoint master_import_row`)
    } catch (error) {
      await tx.execute(sql`rollback to savepoint master_import_row`)
      await tx.execute(sql`release savepoint master_import_row`)
      throw error
    }
  })
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
         limit ${MAX_EXPORT_ROWS + 1}`)) as { rows: Record<string, unknown>[] }
      // Sentinel read: one row past the cap proves overflow; exactly at the
      // cap proves completeness. Refuse rather than truncate silently.
      enforceExportRowLimit(result.rows, masterDescriptor(m).label)
      const customDefs = fields.filter((f) => f.custom)
      const out: Record<string, CellValue>[] = []
      for (const raw of result.rows) {
        const row: Record<string, CellValue> = {}
        for (const c of exportCols) {
          const f = fields.find((x) => x.key === c.key)!
          row[c.key] = await exportMasterCell(f, raw[c.column], resolver, orgId)
        }
        const custom = (raw.custom ?? {}) as Record<string, unknown>
        for (const f of customDefs) row[f.key] = await exportMasterCell(f, custom[f.key], resolver, orgId)
        out.push(row)
      }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: out }
    },
    async write(rows, mode, ctx) {
      return writeMaster(m, rows, mode, ctx)
    },
  }
}

/**
 * Synthesize a stable, human-readable shortCode from a display name.
 * Deterministic for a given name and taken-set, so re-importing the same
 * export resolves to the same code and stays idempotent. Suffixed on
 * collision, and registered in `taken` so one file never mints a dup.
 */
function nextPartyShortCode(displayName: string, taken: Set<string>): string {
  const base = displayName.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20) || 'PARTY'
  let code = base
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`
  taken.add(code)
  return code
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
  // Codeless parties resolve against the codes already taken in this org
  // (plus codes minted earlier in this file), so a synthesized shortCode is
  // unique on insert and stable on re-import. One narrow query per import —
  // never a query per row beyond the name-match below.
  const needsPartyCodes = m.key === 'parties' &&
    rows.some((r) => String(r[m.naturalKey] ?? '').trim() === '')
  const takenPartyCodes = needsPartyCodes
    ? new Set((((await db.execute(sql`
        select short_code from parties where org_id = ${ctx.orgId}`)) as {
        rows: { short_code: string | null }[]
      }).rows.map((r) => String(r.short_code ?? '').trim()).filter((s) => s !== '')))
    : new Set<string>()
  // Bank-typed hygiene needs to know which accounts already back real bank
  // activity. One set per import — never a query per row.
  const statementAccountIds = m.key === 'accounts'
    ? new Set(
      ((await db.execute(sql`
        select distinct account_id as id from bank_statements where org_id = ${ctx.orgId}`)) as {
        rows: { id: string }[]
      }).rows.map((r) => r.id),
    )
    : new Set<string>()

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
        if (!present) continue
        if (c.kind === 'boolean') {
          setCols.push({ column: c.column, value: coerceBoolean(raw) })
          continue
        }
        if (c.kind === 'reference' && c.ref) {
          const id = await resolveMasterRefId(resolver, c.ref, raw, ctx.orgId)
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
        if (c.kind === 'number' || c.kind === 'currency' || c.kind === 'percent') {
          // Exact-decimal boundary, matching the interactive/API writers
          // (exactMoney): Number() accepts hex, exponents, and over-scale
          // fractions that PostgreSQL then silently rounds into numeric(19,4)
          // ('12.345678' stores as 12.3457), so the canonical text form is
          // validated and stored instead of the raw input.
          const exact = canonicalDecimal(raw, 4)
          let normalized: string | null = null
          if (exact !== null) {
            try {
              normalized = normalizeMoney(exact)
            } catch {
              normalized = null
            }
          }
          if (normalized === null) {
            err = `${c.key} must be an exact decimal with at most 4 decimal places`
            break
          }
          setCols.push({ column: c.column, value: normalized })
          continue
        }
        // Every other present cell (text, validated selects) binds as-is.
        setCols.push({ column: c.column, value: raw })
      }
      if (err) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: err })
        continue
      }

      // Custom fields → validated `custom` jsonb. Reference fields resolve
      // through the org-scoped resolver first: custom values are schemaless
      // jsonb with no FK, so a raw foreign UUID would otherwise persist blind
      // (the shape check below only verifies UUID syntax, never ownership).
      const customInput: Record<string, unknown> = {}
      for (const d of defs) {
        // Native clear semantics: a blank is omitted and validateCustomValues
        // leaves the stored value alone — it must never resolve to not-found.
        if (src[d.key] === undefined || src[d.key] === null || src[d.key] === '') continue
        if (d.fieldType === 'reference' && d.config.referenceTable) {
          const id = await resolver.resolveId(
            { resource: d.config.referenceTable, by: 'id' },
            src[d.key],
          )
          if (!id) {
            err = `${d.key}: "${String(src[d.key])}" not found`
            break
          }
          customInput[d.key] = id
        } else {
          customInput[d.key] = src[d.key]
        }
      }
      if (err) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: err })
        continue
      }
      let nkVal = String(src[m.naturalKey] ?? '').trim()
      // A master row without its natural key has no identity: it can never
      // match on re-import, so every import would duplicate it. Refuse it in
      // every mode with the key named — except a parties shortCode, which the
      // product itself leaves blank (CRM drafts, role populations) and which
      // export emits empty. A blank code resolves instead: adopt the code of
      // the uniquely name-matched party, or synthesize a stable one, so an
      // exported file re-imports losslessly.
      let codeFill: string | null = null
      let adoptedParty: { row: Record<string, unknown> } | null = null
      let identityLabel: string | null = null
      if (!nkVal && m.key === 'parties') {
        const displayName = String(src.displayName ?? '').trim()
        const matches = displayName ? ((await db.execute(sql`
          select * from parties
           where org_id = ${ctx.orgId} and display_name = ${displayName} limit 2`)) as {
          rows: Record<string, unknown>[]
        }).rows : []
        if (matches.length > 1) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: `multiple parties named "${displayName}": supply shortCode to disambiguate` })
          continue
        }
        const matched = matches[0]
        const matchedCode = String(matched?.short_code ?? '').trim()
        if (matched && matchedCode !== '' && typeof matched.id === 'string') {
          nkVal = matchedCode
          adoptedParty = { row: matched }
        } else if (matched && typeof matched.id === 'string') {
          codeFill = nextPartyShortCode(displayName, takenPartyCodes)
          nkVal = codeFill
          adoptedParty = { row: matched }
          identityLabel = `displayName="${displayName}"`
        } else {
          codeFill = nextPartyShortCode(displayName, takenPartyCodes)
          nkVal = codeFill
        }
      }
      if (!nkVal) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `${m.naturalKey} is required` })
        continue
      }
      // A codeless row that adopted a generated code still needs it stored:
      // inserts carry it as a column, updates fill the empty stored key
      // (the update below never rewrites a populated natural key).
      if (codeFill && !adoptedParty) setCols.push({ column: 'short_code', value: codeFill })
      const adoptedRow = adoptedParty?.row
      let existingId: string | null =
        typeof adoptedRow?.id === 'string' ? adoptedRow.id : null
      let existingCustom: Record<string, unknown> =
        (adoptedRow?.custom as Record<string, unknown> | undefined) ?? {}
      let storedKind: string | undefined =
        typeof adoptedRow?.kind === 'string' ? adoptedRow.kind : undefined
      let storedAccount: { type?: string; name?: string; reconcilable?: boolean; is_summary?: boolean } | undefined
      // The full stored row doubles as the update's audit before-image.
      let beforeRow: Record<string, unknown> | null = adoptedRow ?? null
      if (nkVal && !adoptedParty) {
        const found = (await db.execute(sql`
          select * from ${sql.raw(m.table)}
           where ${sql.raw(nkColumn)} = ${nkVal} and org_id = ${ctx.orgId} limit 1`)) as {
          rows: Record<string, unknown>[]
        }
        beforeRow = (found.rows[0] ?? null) as Record<string, unknown> | null
        existingId = typeof beforeRow?.id === 'string' ? beforeRow.id : null
        existingCustom = (beforeRow?.custom as Record<string, unknown> | undefined) ?? {}
        storedKind = typeof beforeRow?.kind === 'string' ? beforeRow.kind : undefined
        if (m.key === 'accounts' && beforeRow) {
          storedAccount = {
            type: beforeRow.type as string | undefined,
            name: beforeRow.name as string | undefined,
            reconcilable: beforeRow.reconcilable as boolean | undefined,
            is_summary: beforeRow.is_summary as boolean | undefined,
          }
        }
      }

      // Updates are partial: required custom fields omitted from the import
      // row are satisfied by the existing stored values. Supplied fields still
      // override them, while inserts validate against the empty stored bag.
      const cv = validateCustomValues(defs, { ...existingCustom, ...customInput })
      if (!cv.ok) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: Object.values(cv.errors).join('; ') })
        continue
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
        outcome.errors.push({ row: rowNo, message: identityLabel
          ? `already exists (${identityLabel})`
          : `already exists (${m.naturalKey}=${nkVal})` })
        continue
      }

      const mergedCustom = { ...existingCustom, ...cv.cleaned }
      if (existingId) {
        if (!ctx.dryRun) {
          const parts = setCols
            .filter((c) => c.column !== nkColumn) // don't rewrite the natural key
            .map((c) => sql`${sql.raw(c.column)} = ${c.value}`)
          // ...unless the key itself was just synthesized for a codeless
          // row: filling an empty stored key gives the row its identity
          // for the next re-import.
          if (codeFill && String(adoptedRow?.short_code ?? '').trim() === '') {
            parts.push(sql`short_code = ${codeFill}`)
          }
          parts.push(sql`custom = ${JSON.stringify(mergedCustom)}::jsonb`)
          parts.push(sql`updated_by = ${ctx.actorId}`)
          parts.push(sql`updated_at = now()`)
          await persistMasterMutation(m.table, 'update', ctx, beforeRow, async (tx) => {
            const written = (await tx.execute(sql`
              update ${sql.raw(m.table)} set ${sql.join(parts, sql`, `)}
               where id = ${existingId} and org_id = ${ctx.orgId}
               returning *`)) as { rows: Record<string, unknown>[] }
            const after = written.rows[0] ?? null
            if (!after) throw new Error('master-data mutation did not return a row')
            return { rowId: existingId, after }
          })
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
          await persistMasterMutation(m.table, 'insert', ctx, null, async (tx) => {
            const ins = (await tx.execute(sql`
              insert into ${sql.raw(m.table)} (${names}) values (${values}) returning *`)) as {
              rows: Record<string, unknown>[]
            }
            const after = ins.rows[0] ?? null
            if (!after || typeof after.id !== 'string') {
              throw new Error('master-data mutation did not return a row')
            }
            return { rowId: after.id, after }
          })
        }
        outcome.created++
      }

      // Bank-typed hygiene: warn on uncorroborated asset_bank in preview and
      // commit alike. Effective values — the row's cells over the stored row —
      // so a partial update re-checks the account as it will stand.
      if (m.key === 'accounts') {
        const cell = (column: string): unknown => setCols.find((c) => c.column === column)?.value
        const warning = assetBankHygieneWarning({
          type: String(cell('type') ?? storedAccount?.type ?? ''),
          name: String(cell('name') ?? storedAccount?.name ?? ''),
          reconcilable: Boolean(cell('reconcilable') ?? storedAccount?.reconcilable ?? false),
          isSummary: Boolean(cell('is_summary') ?? storedAccount?.is_summary ?? false),
          hasStatements: existingId ? statementAccountIds.has(existingId) : false,
        })
        if (warning) {
          if (!outcome.warnings) outcome.warnings = []
          outcome.warnings.push({ row: rowNo, message: warning, field: 'type' })
        }
      }
    } catch (e) {
      outcome.failed++
      outcome.errors.push({ row: rowNo, message: (e as { message?: string })?.message ?? 'write failed' })
    }
  }
  return outcome
}

async function auditRow(
  executor: SqlExecutor,
  table: string,
  rowId: string,
  action: 'insert' | 'update',
  ctx: WriteCtx,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${ctx.orgId}, ${table}, ${rowId}, ${action},
            ${JSON.stringify({ source: 'import', before, after })}::jsonb, ${ctx.actorId})`)
}
