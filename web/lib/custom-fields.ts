import 'server-only'
import { sql } from 'drizzle-orm'
import { CUSTOM_FIELD_REFERENCE_TABLES } from '@openbooks/customization'
import { isIsoCalendarDate as isValidIsoDate } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal, compareDecimal } from './exact-decimal'

/**
 * Custom fields platform — source platform-style header/line/entity extensions.
 * Definitions live in custom_field_defs (targetTable + optional targetKind);
 * values live in each row's `custom` jsonb, validated here before write.
 * Every module renders its defs dynamically: document drawers (header),
 * LineGrid (line columns), record views.
 */

export type CustomFieldDef = {
  id: string
  targetTable: string
  targetKind: string | null
  key: string
  label: string
  fieldType:
    | 'text'
    | 'long_text'
    | 'number'
    | 'currency'
    | 'date'
    | 'boolean'
    | 'select'
    | 'multi_select'
    | 'reference'
  config: {
    options?: string[]
    helpText?: string
    placeholder?: string
    defaultValue?: unknown
    min?: number | string
    max?: number | string
    showInList?: boolean
    displayMode?: string
    allowedRoles?: string[]
    referenceTable?: string
    referenceFilter?: string
  }
  isRequired: boolean
  sortOrder: number
};

export async function loadFieldDefs(targetTable: string, targetKind?: string): Promise<CustomFieldDef[]> {
  const r = (await db.execute<CustomFieldDef>(sql`
    select id, target_table as "targetTable", target_kind as "targetKind", key, label,
           field_type as "fieldType", config, is_required as "isRequired", sort_order as "sortOrder"
      from custom_field_defs
     where target_table = ${targetTable}
       and (target_kind is null or target_kind = ${targetKind ?? null})
       and is_active
     order by sort_order, label
  `))
  return r.rows
}

export interface ValidationResult {
  ok: boolean
  errors: Record<string, string>
  /** Only defined keys survive; unknown keys are stripped. */
  cleaned: Record<string, unknown>
}

export function validateCustomValues(
  defs: CustomFieldDef[],
  values: Record<string, unknown> | undefined | null,
): ValidationResult {
  const input = values ?? {}
  const errors: Record<string, string> = {}
  const cleaned: Record<string, unknown> = {}

  for (const def of defs) {
    const raw = input[def.key]
    const empty = raw === undefined || raw === null || raw === ''
    if (empty) {
      if (def.isRequired) errors[def.key] = `${def.label} is required`
      continue
    }
    switch (def.fieldType) {
      case 'text':
      case 'long_text':
        cleaned[def.key] = String(raw)
        break
      case 'currency': {
        const exact = canonicalDecimal(raw, 4)
        if (exact === null) {
          errors[def.key] = `${def.label} must be an exact decimal`
          break
        }
        let amount: string
        try {
          amount = normalizeMoney(exact)
        } catch {
          errors[def.key] = `${def.label} must be an exact decimal`
          break
        }
        if (def.config.min != null && compareDecimal(amount, String(def.config.min)) < 0) {
          errors[def.key] = `${def.label} must be ≥ ${def.config.min}`
          break
        }
        if (def.config.max != null && compareDecimal(amount, String(def.config.max)) > 0) {
          errors[def.key] = `${def.label} must be ≤ ${def.config.max}`
          break
        }
        cleaned[def.key] = amount
        break
      }
      case 'number': {
        const exact = canonicalDecimal(raw, 4)
        if (exact === null) {
          errors[def.key] = `${def.label} must be an exact decimal`
          break
        }
        if (def.config.min != null && compareDecimal(exact, String(def.config.min)) < 0) {
          errors[def.key] = `${def.label} must be ≥ ${def.config.min}`
          break
        }
        if (def.config.max != null && compareDecimal(exact, String(def.config.max)) > 0) {
          errors[def.key] = `${def.label} must be ≤ ${def.config.max}`
          break
        }
        cleaned[def.key] = exact
        break
      }
      case 'date': {
        if (!isValidIsoDate(raw)) errors[def.key] = `${def.label} must be a date`
        else cleaned[def.key] = raw
        break
      }
      case 'boolean':
        if (raw === true || raw === 'true') cleaned[def.key] = true
        else if (raw === false || raw === 'false') cleaned[def.key] = false
        else errors[def.key] = `${def.label} must be a boolean`
        break
      case 'select': {
        const opts = def.config.options ?? []
        if (!opts.includes(String(raw))) errors[def.key] = `${def.label}: invalid option`
        else cleaned[def.key] = raw
        break
      }
      case 'multi_select': {
        const opts = def.config.options ?? []
        const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)]
        if (arr.some((v) => !opts.includes(v))) errors[def.key] = `${def.label}: invalid option`
        else cleaned[def.key] = arr
        break
      }
      case 'reference': {
        if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
          errors[def.key] = `${def.label} must be a valid record reference`
        } else {
          cleaned[def.key] = raw
        }
        break
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors, cleaned }
}

const REFERENCE_OWNER_TABLES: ReadonlySet<string> = new Set(
  CUSTOM_FIELD_REFERENCE_TABLES as readonly string[],
)

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Tenant ownership for `reference`-type custom values. `validateCustomValues`
 * proves uuid SHAPE only, so without this a caller can persist another org's
 * row id (or a dangling uuid) blind into tenant jsonb — the master-data
 * import path already resolves the same fields through an org-scoped resolver
 * and refuses unknown ids. Batched per table, mirroring the document line-ref
 * precheck: one query per referenced table, only for values actually present.
 * Returns the defs whose value is not owned by `orgId` (callers map to a
 * tenant-opaque 404). Shape-invalid values are left to `validateCustomValues`;
 * defs pointing outside the designer whitelist cannot be scoped and are
 * skipped.
 */
export async function findUnownedCustomReferences(
  orgId: string,
  defs: CustomFieldDef[],
  values: Record<string, unknown>,
): Promise<CustomFieldDef[]> {
  const wanted = new Map<string, { def: CustomFieldDef; value: string }[]>()
  for (const def of defs) {
    if (def.fieldType !== 'reference') continue
    const table = def.config?.referenceTable
    if (typeof table !== 'string' || !REFERENCE_OWNER_TABLES.has(table)) continue
    const raw = values[def.key]
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) continue
    const list = wanted.get(table) ?? []
    list.push({ def, value: raw })
    wanted.set(table, list)
  }
  const unowned: CustomFieldDef[] = []
  for (const [table, refs] of wanted) {
    const ids = [...new Set(refs.map((r) => r.value))]
    const owned = new Set(
      (
        await db.execute<{ id: string }>(sql`
          select id from ${sql.raw(`"${table}"`)}
           where org_id = ${orgId} and id = any(${`{${ids.join(',')}}`}::uuid[])`)
      ).rows.map((r) => r.id),
    )
    for (const ref of refs) {
      if (!owned.has(ref.value)) unowned.push(ref.def)
    }
  }
  return unowned
}
