// Pure helpers shared by the record-type builder, the generated module UI,
// and the /api/records routes — client-safe (no db / server-only imports).
//
// A custom record type stores a flat FormField[] (the @openbooks/forms-core
// field model). All validation reuses forms-core by wrapping those fields in
// a synthetic single-section FormSchemaV1, so record types and app-builder
// forms can never disagree about what a valid field definition or value is.

import {
  evaluateFormulaTree,
  formFieldSchema,
  lintFormSchema,
  validateResponse,
  type FieldType,
  type FieldValueMap,
  type FormField,
  type FormSchemaV1,
  type SchemaIssue,
  type ValidationError,
} from '@openbooks/forms-core'

/**
 * Field types offered by the record-type builder. The forms-core registry
 * minus `signature` and `file`: records are master data, not attested
 * submissions, and file metadata without storage is meaningless on a record.
 */
export const RECORD_FIELD_TYPES: readonly FieldType[] = [
  'text',
  'long_text',
  'number',
  'currency',
  'percentage',
  'select',
  'multi_select',
  'radio',
  'date',
  'datetime',
  'rating',
  'formula',
  'gl_account',
  'party',
] as const

const RECORD_FIELD_TYPE_SET: ReadonlySet<string> = new Set(RECORD_FIELD_TYPES)

/** Statuses shared with schema/src/custom-records.ts (kept in lockstep). */
export const RECORD_TYPE_STATUSES = ['draft', 'published', 'archived'] as const
export const RECORD_STATUSES = ['draft', 'active', 'inactive'] as const
export type RecordTypeStatus = (typeof RECORD_TYPE_STATUSES)[number]
export type RecordStatus = (typeof RECORD_STATUSES)[number]

/**
 * Type keys are URL segments (/records/<key>) and number-sequence kinds
 * ('custrec:'+key): lowercase slugs, letter-first, 2–64 chars.
 */
export const TYPE_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/

/**
 * Slugs that collide with static /records/* and /api/records/* segments —
 * a type keyed `types` would shadow the builder itself.
 */
export const RESERVED_TYPE_KEYS: ReadonlySet<string> = new Set(['types', 'new'])

export function typeKeyError(key: string): string | null {
  if (!TYPE_KEY_RE.test(key)) {
    return 'Key must be 2–64 characters: lowercase letters, numbers, and hyphens, starting with a letter'
  }
  if (RESERVED_TYPE_KEYS.has(key)) return `"${key}" is a reserved key`
  return null
}

/** "Purchase Orders" → "purchase-orders" (best-effort; user can edit). */
export function slugifyTypeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
}

/** "Serial number" → "serial_number" — field ids obey forms-core identifiers. */
export function slugifyFieldId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

/**
 * Record-number prefix derived from the type key: first three alphanumeric
 * characters, uppercased ('equipment' → 'EQU-'), falling back to 'REC-'.
 * number_sequences pins the prefix at first allocation, so later key edits
 * (only possible while the type is a draft, before any allocation) are safe.
 */
export function recordNumberPrefix(typeKey: string): string {
  const letters = typeKey.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase()
  return `${letters || 'REC'}-`
}

// --- Field definition validation --------------------------------------------

/** Wrap a record type's flat field list in the synthetic one-section schema. */
export function recordFormSchema(fields: FormField[], title: string): FormSchemaV1 {
  return {
    schemaVersion: 1,
    title: title || 'Record',
    sections: [{ id: 'main', title: 'Details', fields }],
  }
}

/**
 * Full designer-side validation of a record type's fields: zod structure,
 * every forms-core cross-field invariant (duplicate ids, choice options,
 * formula/showIf reference checking, numeric config sanity, …), plus the
 * record-type restriction to RECORD_FIELD_TYPES.
 */
export function lintRecordFields(input: unknown, typeName: string):
  | { success: true; fields: FormField[]; issues: SchemaIssue[] }
  | { success: false; issues: SchemaIssue[] } {
  // Structural validation per element via the forms-core zod schema (web
  // deliberately has no direct zod dependency — forms-core owns the shapes).
  if (!Array.isArray(input)) {
    return { success: false, issues: [{ path: [], message: 'Fields must be a list' }] }
  }
  if (input.length > 200) {
    return { success: false, issues: [{ path: [], message: 'No more than 200 fields' }] }
  }
  const fields: FormField[] = []
  const structuralIssues: SchemaIssue[] = []
  input.forEach((candidate, index) => {
    const parsed = formFieldSchema.safeParse(candidate)
    if (parsed.success) {
      fields.push(parsed.data)
    } else {
      for (const i of parsed.error.issues) {
        structuralIssues.push({
          path: [
            index,
            ...i.path.filter(
              (p): p is string | number => typeof p === 'string' || typeof p === 'number',
            ),
          ],
          message: i.message,
        })
      }
    }
  })
  if (structuralIssues.length > 0) return { success: false, issues: structuralIssues }
  const issues: SchemaIssue[] = []
  fields.forEach((f, index) => {
    if (!RECORD_FIELD_TYPE_SET.has(f.type)) {
      issues.push({
        path: [index, 'type'],
        message: `"${f.type}" fields are not available on custom records`,
      })
    }
  })
  // lintFormSchema paths are ['sections', 0, 'fields', i, …] — strip the
  // synthetic wrapper so issues point back into the flat field list.
  for (const issue of lintFormSchema(recordFormSchema(fields, typeName))) {
    issues.push(
      issue.path[0] === 'sections' && issue.path[2] === 'fields'
        ? { ...issue, path: issue.path.slice(3) }
        : issue,
    )
  }
  return { success: true, fields, issues }
}

/** Human-readable "fields[2].label: …" line for toast/issue lists. */
export function describeIssue(issue: SchemaIssue): string {
  const path = issue.path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i === 0 ? '' : '.'}${p}`))
    .join('')
  return path ? `${path}: ${issue.message}` : issue.message
}

// --- Record value validation + formulas --------------------------------------

/**
 * Validate a record's data payload against the type's fields via the
 * forms-core response validator. `stage: 'draft'` relaxes required checks
 * (autosave); `'submit'` enforces them (activation). Unknown keys are
 * rejected — a payload can't smuggle arbitrary jsonb past the field defs.
 */
export function validateRecordData(
  fields: FormField[],
  data: FieldValueMap,
  stage: 'draft' | 'submit',
): ValidationError[] {
  return validateResponse(recordFormSchema(fields, 'Record'), data, {}, stage)
}

/**
 * Recompute every formula field from the caller-supplied values and persist
 * the results alongside them (lists and reports read stored values, never
 * re-evaluate trees). Caller-supplied values under a formula id are always
 * overwritten. Pure — shared verbatim by the PATCH route and the drawer's
 * live preview.
 */
export function withComputedFormulas(fields: FormField[], values: FieldValueMap): FieldValueMap {
  const out: FieldValueMap = { ...values }
  const ctx = { values, rows: {} }
  for (const f of fields) {
    if (f.type !== 'formula') continue
    out[f.id] = f.formula ? evaluateFormulaTree(f.formula, ctx) : null
  }
  return out
}

// --- Display formatting -------------------------------------------------------

export type EntityLabelMaps = {
  /** parties.id → display_name */
  parties?: ReadonlyMap<string, string>
  /** accounts.id → "1000 Cash" */
  accounts?: ReadonlyMap<string, string>
}

function formatAmount(n: number, decimals: number): string {
  return n.toLocaleString('en-CA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function formatDateValue(v: string): string {
  return v // yyyy-mm-dd is already the canonical, sortable display
}

function formatDateTimeValue(v: string): string {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
}

function choiceLabel(field: FormField, value: string): string {
  return field.validation?.options?.find((o) => o.value === value)?.label ?? value
}

/**
 * Format one field's stored value for display (list cells, read-only drawer
 * values). Entity refs resolve through the caller-resolved label maps —
 * lists batch-resolve names server-side; pickers render their own labels.
 * Returns '' for empty values (cells render an em-dash themselves).
 */
export function formatFieldValue(
  field: FormField,
  value: unknown,
  labels: EntityLabelMaps = {},
): string {
  if (value === null || value === undefined || value === '') return ''
  switch (field.type) {
    case 'currency':
      return formatAmount(Number(value), 2)
    case 'percentage':
      return `${formatAmount(Number(value), 2).replace(/\.00$/, '')}%`
    case 'number': {
      const unit = typeof field.config?.unit === 'string' ? field.config.unit : ''
      const text = Number(value).toLocaleString('en-CA', { maximumFractionDigits: 6 })
      return unit ? `${text} ${unit}` : text
    }
    case 'rating': {
      const max =
        typeof field.config?.max === 'number' && Number.isInteger(field.config.max)
          ? field.config.max
          : 5
      return `${Number(value)}/${max}`
    }
    case 'date':
      return typeof value === 'string' ? formatDateValue(value) : String(value)
    case 'datetime':
      return typeof value === 'string' ? formatDateTimeValue(value) : String(value)
    case 'select':
    case 'radio':
      return typeof value === 'string' ? choiceLabel(field, value) : String(value)
    case 'multi_select':
      return Array.isArray(value)
        ? value.map((v) => choiceLabel(field, String(v))).join(', ')
        : String(value)
    case 'party':
      return labels.parties?.get(String(value)) ?? ''
    case 'gl_account':
      return labels.accounts?.get(String(value)) ?? ''
    case 'formula': {
      const format = typeof field.config?.format === 'string' ? field.config.format : 'number'
      if (typeof value === 'number') {
        if (format === 'currency') return formatAmount(value, 2)
        if (format === 'percentage') return `${formatAmount(value, 2).replace(/\.00$/, '')}%`
        return value.toLocaleString('en-CA', { maximumFractionDigits: 6 })
      }
      return String(value)
    }
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

/** Right-aligned tabular-nums treatment for money-ish columns. */
export function isNumericField(field: FormField): boolean {
  if (field.type === 'formula') {
    const format = typeof field.config?.format === 'string' ? field.config.format : 'number'
    return format !== 'text'
  }
  return field.type === 'number' || field.type === 'currency' || field.type === 'percentage'
}

/** Value-bearing fields (incl. formulas) — what lists/columns derive from. */
export function listableFields(fields: FormField[]): FormField[] {
  return fields.filter((f) => f.type !== 'long_text')
}
