import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Custom fields platform — source platform-style header/line/entity extensions.
 * Definitions live in custom_field_defs (targetTable + optional targetKind);
 * values live in each row's `custom` jsonb, validated here before write.
 * Every module renders its defs dynamically: document drawers (header),
 * LineGrid (line columns), record views.
 */

export interface CustomFieldDef {
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
    min?: number
    max?: number
    showInList?: boolean
    displayMode?: string
    allowedRoles?: string[]
    referenceTable?: string
    referenceFilter?: string
  }
  isRequired: boolean
  sortOrder: number
}

export async function loadFieldDefs(targetTable: string, targetKind?: string): Promise<CustomFieldDef[]> {
  const r = (await db.execute(sql`
    select id, target_table as "targetTable", target_kind as "targetKind", key, label,
           field_type as "fieldType", config, is_required as "isRequired", sort_order as "sortOrder"
      from custom_field_defs
     where target_table = ${targetTable}
       and (target_kind is null or target_kind = ${targetKind ?? null})
       and is_active
     order by sort_order, label
  `)) as unknown as { rows: CustomFieldDef[] }
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
      case 'number':
      case 'currency': {
        const n = Number(raw)
        if (Number.isNaN(n)) {
          errors[def.key] = `${def.label} must be a number`
          break
        }
        if (def.config.min != null && n < def.config.min) {
          errors[def.key] = `${def.label} must be ≥ ${def.config.min}`
          break
        }
        if (def.config.max != null && n > def.config.max) {
          errors[def.key] = `${def.label} must be ≤ ${def.config.max}`
          break
        }
        cleaned[def.key] = def.fieldType === 'currency' ? n.toFixed(2) : n
        break
      }
      case 'date': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) errors[def.key] = `${def.label} must be a date`
        else cleaned[def.key] = raw
        break
      }
      case 'boolean':
        cleaned[def.key] = raw === true || raw === 'true'
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
