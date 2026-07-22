// Pure helpers shared by the record-type builder, the generated module UI,
// and the /api/records routes — client-safe (no db / server-only imports).
//
// A custom record type stores an ordered list of SECTIONS (the forms-core
// FormSection[] model). A section is either a non-repeating HEADER group
// (fields rendered as a grid) or a REPEATING line list (a sublist/table whose
// rows are stored as an array). All validation reuses forms-core by wrapping
// those sections in a FormSchemaV1, so record types and app-builder forms can
// never disagree about what a valid field definition or value is.
//
// The stored `custom_record_types.fields` jsonb still carries the definition;
// `normalizeSections` accepts either the new FormSection[] shape or a legacy
// flat FormField[] (wrapped into a single "Details" header section on read),
// so no data migration is required.
//
// A record's `data` jsonb is one merged map: header field values keyed by
// field id, plus each repeating section's rows keyed by SECTION id
// (data[sectionId] = [{ rowFieldId: value }, …]). `splitRecordData` /
// `mergeRecordData` convert between that stored shape and the (values, rows)
// pair the forms-core evaluators and validator expect.

import {
  evaluateFormulaTree,
  formSectionSchema,
  lintFormSchema,
  validateResponse,
  type FieldType,
  type FieldValueMap,
  type FormField,
  type FormSchemaV1,
  type FormSection,
  type RowMap,
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

// --- Section normalization ----------------------------------------------------

/** A record type's definition is an ordered list of forms-core sections. */
export type RecordSection = FormSection

/** Ceilings for a record type's definition (belt-and-braces around forms-core). */
export const MAX_RECORD_SECTIONS = 50
export const MAX_RECORD_FIELDS = 200

function looksLikeSection(el: unknown): boolean {
  return Boolean(el) && typeof el === 'object' && Array.isArray((el as { fields?: unknown }).fields)
}

/**
 * Coerce the stored `fields` jsonb into a raw sections array (still
 * unvalidated — `lintRecordFields` runs the forms-core zod + invariants).
 *
 *   []                     → [] (an empty draft has no sections yet)
 *   FormSection[]          → as-is (the current shape)
 *   legacy flat FormField[] → wrapped in one non-repeating "Details" section
 */
export function normalizeSectionsInput(input: unknown): unknown[] {
  if (!Array.isArray(input) || input.length === 0) return []
  if (input.every(looksLikeSection)) return input
  return [{ id: 'main', title: 'Details', fields: input }]
}

/** Every field across all sections (header + repeating), definition order. */
export function flattenFields(sections: FormSection[]): FormField[] {
  return sections.flatMap((s) => s.fields)
}

/** Fields of the non-repeating (header) sections only. */
export function headerFields(sections: FormSection[]): FormField[] {
  return sections.filter((s) => !s.repeating).flatMap((s) => s.fields)
}

// --- Field definition validation --------------------------------------------

/** Wrap a record type's sections in a FormSchemaV1 for forms-core validation. */
export function recordFormSchema(sections: FormSection[], title: string): FormSchemaV1 {
  return { schemaVersion: 1, title: title || 'Record', sections }
}

/**
 * Full designer-side validation of a record type's sections: zod structure,
 * every forms-core cross-field invariant (duplicate ids across sections,
 * choice options, formula/showIf/rollup reference checking, repeating min/max
 * rows, numeric config sanity, …), plus the record-type restriction to
 * RECORD_FIELD_TYPES. Returns the validated `sections`, a flattened `fields`
 * list (for id-keyed operations), and the current issue list.
 */
export function lintRecordFields(input: unknown, typeName: string):
  | { success: true; sections: FormSection[]; fields: FormField[]; issues: SchemaIssue[] }
  | { success: false; issues: SchemaIssue[] } {
  const raw = normalizeSectionsInput(input)
  if (raw.length > MAX_RECORD_SECTIONS) {
    return { success: false, issues: [{ path: [], message: `No more than ${MAX_RECORD_SECTIONS} sections` }] }
  }
  // Structural validation per section via the forms-core zod schema (web
  // deliberately has no direct zod dependency — forms-core owns the shapes).
  const sections: FormSection[] = []
  const structuralIssues: SchemaIssue[] = []
  raw.forEach((candidate, index) => {
    const parsed = formSectionSchema.safeParse(candidate)
    if (parsed.success) {
      sections.push(parsed.data)
    } else {
      for (const i of parsed.error.issues) {
        structuralIssues.push({
          path: [
            'sections',
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

  const fields = flattenFields(sections)
  if (fields.length > MAX_RECORD_FIELDS) {
    return { success: false, issues: [{ path: [], message: `No more than ${MAX_RECORD_FIELDS} fields` }] }
  }

  const issues: SchemaIssue[] = []
  sections.forEach((section, si) => {
    section.fields.forEach((f, fi) => {
      if (!RECORD_FIELD_TYPE_SET.has(f.type)) {
        issues.push({
          path: ['sections', si, 'fields', fi, 'type'],
          message: `"${f.type}" fields are not available on custom records`,
        })
      }
    })
  })
  for (const issue of lintFormSchema(recordFormSchema(sections, typeName))) issues.push(issue)
  return { success: true, sections, fields, issues }
}

/** Human-readable "fields[2].label: …" line for toast/issue lists. */
export function describeIssue(issue: SchemaIssue): string {
  const path = issue.path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i === 0 ? '' : '.'}${p}`))
    .join('')
  return path ? `${path}: ${issue.message}` : issue.message
}

// --- Record value shape (merged data ⇄ values/rows) ---------------------------

/**
 * Split a record's merged `data` map into the (values, rows) pair the
 * forms-core evaluators/validator expect: repeating-section ids become
 * `rows[sectionId]` (coerced to an array); everything else is a header value.
 */
export function splitRecordData(
  sections: FormSection[],
  data: FieldValueMap,
): { values: FieldValueMap; rows: RowMap } {
  const repeatingIds = new Set(sections.filter((s) => s.repeating).map((s) => s.id))
  const values: FieldValueMap = {}
  const rows: RowMap = {}
  for (const [k, v] of Object.entries(data)) {
    if (repeatingIds.has(k)) rows[k] = Array.isArray(v) ? (v as FieldValueMap[]) : []
    else values[k] = v
  }
  return { values, rows }
}

/** Merge header values and repeating rows back into the stored `data` shape. */
export function mergeRecordData(values: FieldValueMap, rows: RowMap): FieldValueMap {
  return { ...values, ...rows }
}

/**
 * Drop anything not declared by the current sections: unknown header keys,
 * unknown repeating-section keys, and unknown row-field keys within each row
 * (a designer removed a field after records were saved). Non-array values
 * under a repeating section id collapse to []. Keeps the write path from
 * tripping the validator's unknown-key rejection on stale data.
 */
export function stripUnknownData(sections: FormSection[], data: FieldValueMap): FieldValueMap {
  const headerIds = new Set<string>()
  const repeating = new Map<string, Set<string>>()
  for (const s of sections) {
    if (s.repeating) repeating.set(s.id, new Set(s.fields.map((f) => f.id)))
    else for (const f of s.fields) headerIds.add(f.id)
  }
  const out: FieldValueMap = {}
  for (const [k, v] of Object.entries(data)) {
    if (headerIds.has(k)) {
      out[k] = v
    } else if (repeating.has(k)) {
      const rowIds = repeating.get(k)!
      const arr = Array.isArray(v) ? v : []
      out[k] = arr.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return {}
        const nextRow: FieldValueMap = {}
        for (const [rk, rv] of Object.entries(row as FieldValueMap)) {
          if (rowIds.has(rk)) nextRow[rk] = rv
        }
        return nextRow
      })
    }
    // unknown key dropped
  }
  return out
}

// --- Record value validation + formulas --------------------------------------

/**
 * Validate a record's data payload against the type's sections via the
 * forms-core response validator. `stage: 'draft'` relaxes required checks
 * (autosave); `'submit'` enforces them (activation, incl. repeating minRows).
 * Unknown keys are rejected — a payload can't smuggle arbitrary jsonb past the
 * field defs.
 */
export function validateRecordData(
  sections: FormSection[],
  data: FieldValueMap,
  stage: 'draft' | 'submit',
): ValidationError[] {
  const { values, rows } = splitRecordData(sections, data)
  return validateResponse(recordFormSchema(sections, 'Record'), values, rows, stage)
}

/**
 * Recompute every formula field and persist the results alongside the inputs
 * (lists and reports read stored values, never re-evaluate trees). Row-level
 * formulas are computed per row first (each row sees its own fields shadowing
 * header values); header formulas then evaluate against the computed rows, so
 * rollups (sum_section, …) read final row values. Pure — shared verbatim by
 * the write path and the drawer's live preview.
 */
export function withComputedFormulas(
  sections: FormSection[],
  data: FieldValueMap,
): FieldValueMap {
  const { values, rows } = splitRecordData(sections, data)

  const outRows: RowMap = { ...rows }
  for (const s of sections) {
    if (!s.repeating) continue
    const rowFormulas = s.fields.filter((f) => f.type === 'formula')
    const sectionRows = rows[s.id] ?? []
    if (rowFormulas.length === 0) {
      outRows[s.id] = sectionRows
      continue
    }
    outRows[s.id] = sectionRows.map((row) => {
      const ctx = { values: { ...values, ...row }, rows }
      const next = { ...row }
      for (const f of rowFormulas) next[f.id] = f.formula ? evaluateFormulaTree(f.formula, ctx) : null
      return next
    })
  }

  const outValues: FieldValueMap = { ...values }
  const ctx = { values, rows: outRows }
  for (const s of sections) {
    if (s.repeating) continue
    for (const f of s.fields) {
      if (f.type !== 'formula') continue
      outValues[f.id] = f.formula ? evaluateFormulaTree(f.formula, ctx) : null
    }
  }
  return mergeRecordData(outValues, outRows)
}

// --- Display formatting -------------------------------------------------------

export type EntityLabelMaps = {
  /** parties.id → display_name */
  parties?: ReadonlyMap<string, string>
  /** accounts.id → "1000 Cash" */
  accounts?: ReadonlyMap<string, string>
}

export type FieldDisplayFormat = {
  locale: string
  money: (value: string | number) => string
}

function formatAmount(n: number, decimals: number, locale = 'en-CA'): string {
  return n.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function formatDateValue(v: string): string {
  return v // yyyy-mm-dd is already the canonical, sortable display
}

function formatDateTimeValue(v: string, locale = 'en-CA'): string {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
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
  display?: FieldDisplayFormat,
): string {
  if (value === null || value === undefined || value === '') return ''
  switch (field.type) {
    case 'currency':
      return display?.money(String(value)) ?? formatAmount(Number(value), 2)
    case 'percentage':
      return `${formatAmount(Number(value), 2, display?.locale).replace(/[.,]00$/, '')}%`
    case 'number': {
      const unit = typeof field.config?.unit === 'string' ? field.config.unit : ''
      const text = Number(value).toLocaleString(display?.locale ?? 'en-CA', { maximumFractionDigits: 6 })
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
      return typeof value === 'string' ? formatDateTimeValue(value, display?.locale) : String(value)
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
        if (format === 'currency') return display?.money(value) ?? formatAmount(value, 2)
        if (format === 'percentage') return `${formatAmount(value, 2, display?.locale).replace(/[.,]00$/, '')}%`
        return value.toLocaleString(display?.locale ?? 'en-CA', { maximumFractionDigits: 6 })
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

/**
 * Header value-bearing fields (incl. formulas) — what the module list's
 * columns, sorts, and choice filters derive from. Repeating-section (line
 * list) fields are excluded: a sublist can't collapse to a single cell.
 */
export function listableFields(sections: FormSection[]): FormField[] {
  return headerFields(sections).filter((f) => f.type !== 'long_text')
}
