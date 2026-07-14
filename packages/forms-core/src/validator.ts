// Response payload validation, ported from the beaconhs form builder and
// trimmed to the openbooks v1 field set. Shared verbatim by the client filler
// (pre-submit) and the server route (authoritative) so the two can never
// disagree about what a valid response is.

import {
  evaluateLogicRule,
  type EvalContext,
  type FieldValueMap,
  type RowMap,
} from './evaluator'
import { FIELD_TYPES, isResponseValueField, type FileMeta } from './field-types'
import {
  textValidationHardLimit,
  type FormField,
  type FormSchemaV1,
  type FormSection,
} from './schema'

export type ValidationError = {
  /**
   * Top-level fields use the bare field id. Row-level errors use the filler's
   * composite key convention `${sectionId}.${rowIndex}.${fieldId}` so they
   * land on the right row input in the UI.
   */
  fieldId: string
  sectionId?: string
  message: string
}

const MAX_REPEATING_ROWS = 500
const MAX_SELECTIONS = 100
const MAX_FILES = 50
const MAX_SIGNATURE_LENGTH = 200
const MAX_NUMERIC_ABS = 1_000_000_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string' && v.trim() === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  return false
}

function isFileMeta(v: unknown): v is FileMeta {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as FileMeta).name === 'string' &&
    (v as FileMeta).name.length > 0 &&
    (v as FileMeta).name.length <= 1_000 &&
    typeof (v as FileMeta).size === 'number' &&
    Number.isFinite((v as FileMeta).size) &&
    (v as FileMeta).size >= 0 &&
    typeof (v as FileMeta).type === 'string' &&
    (v as FileMeta).type.length <= 500
  )
}

/** Validate ONE field's value. Returns error messages (empty = valid). */
function fieldValueErrors(field: FormField, value: unknown): string[] {
  const errors: string[] = []
  const validation = field.validation
  const custom = validation?.message

  const fail = (message: string) => errors.push(custom ?? message)

  switch (field.type) {
    case 'text':
    case 'long_text': {
      if (typeof value !== 'string') {
        fail('Must be text')
        break
      }
      const hardLimit = textValidationHardLimit(field.type) ?? 10_000
      if (value.length > hardLimit) fail(`Must be no longer than ${hardLimit} characters`)
      if (validation?.minLength !== undefined && value.length < validation.minLength) {
        fail(`Must be at least ${validation.minLength} characters`)
      }
      if (validation?.maxLength !== undefined && value.length > validation.maxLength) {
        fail(`Must be no longer than ${validation.maxLength} characters`)
      }
      if (validation?.pattern) {
        // Patterns are constrained to a ReDoS-safe subset at design time
        // (see validationPatternError); execution here is bounded.
        try {
          if (!new RegExp(validation.pattern).test(value)) fail('Does not match the required format')
        } catch {
          /* invalid pattern rejected at design time; ignore */
        }
      }
      break
    }

    case 'number':
    case 'currency':
    case 'percentage':
    case 'rating': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('Must be a number')
        break
      }
      if (Math.abs(value) > MAX_NUMERIC_ABS) fail('Number is out of range')
      const configMin = typeof field.config?.min === 'number' ? field.config.min : undefined
      const configMax = typeof field.config?.max === 'number' ? field.config.max : undefined
      if (field.type === 'rating') {
        const scaleMax =
          typeof field.config?.max === 'number' && Number.isInteger(field.config.max)
            ? field.config.max
            : 5
        if (!Number.isInteger(value) || value < 1 || value > scaleMax) {
          fail(`Must be a whole number between 1 and ${scaleMax}`)
        }
      } else {
        if (configMin !== undefined && value < configMin) fail(`Must be at least ${configMin}`)
        if (configMax !== undefined && value > configMax) fail(`Must be no more than ${configMax}`)
      }
      if (validation?.min !== undefined && value < validation.min) {
        fail(`Must be at least ${validation.min}`)
      }
      if (validation?.max !== undefined && value > validation.max) {
        fail(`Must be no more than ${validation.max}`)
      }
      break
    }

    case 'date': {
      if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
        fail('Must be a valid date (yyyy-mm-dd)')
      }
      break
    }

    case 'datetime': {
      if (
        typeof value !== 'string' ||
        !DATETIME_RE.test(value) ||
        Number.isNaN(Date.parse(value))
      ) {
        fail('Must be a valid date and time')
      }
      break
    }

    case 'select':
    case 'radio': {
      if (typeof value !== 'string') {
        fail('Must be a single choice')
        break
      }
      const options = validation?.options ?? []
      if (!options.some((o) => o.value === value)) fail('Is not one of the allowed options')
      break
    }

    case 'multi_select': {
      if (!Array.isArray(value)) {
        fail('Must be a list of choices')
        break
      }
      if (value.length > MAX_SELECTIONS) fail(`No more than ${MAX_SELECTIONS} selections`)
      const options = validation?.options ?? []
      const allowed = new Set(options.map((o) => o.value))
      if (value.some((v) => typeof v !== 'string' || !allowed.has(v))) {
        fail('Contains a value that is not one of the allowed options')
      }
      if (new Set(value).size !== value.length) fail('Contains duplicate selections')
      break
    }

    case 'signature': {
      // v1: typed-name attestation string. Canvas signatures come later.
      if (typeof value !== 'string' || value.trim().length === 0) {
        fail('Type your full name to sign')
      } else if (value.length > MAX_SIGNATURE_LENGTH) {
        fail(`Must be no longer than ${MAX_SIGNATURE_LENGTH} characters`)
      }
      break
    }

    case 'file': {
      // v1: metadata-only array [{ name, size, type }] — no binary upload.
      if (!Array.isArray(value)) {
        fail('Must be a list of files')
        break
      }
      if (value.length > MAX_FILES) fail(`No more than ${MAX_FILES} files`)
      if (!value.every(isFileMeta)) fail('Contains an invalid file entry')
      break
    }

    case 'gl_account':
    case 'party': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        fail(`Must reference a ${FIELD_TYPES[field.type].label.toLowerCase()}`)
      }
      break
    }

    case 'formula':
      // Computed server-side from field.formula; any submitted value for a
      // formula field is ignored by the write path, never validated here.
      break
  }

  return errors
}

function effectiveRequired(field: FormField): boolean {
  return Boolean(field.required || field.validation?.required)
}

/**
 * Validate a response payload against the form schema.
 * Stage = 'draft' relaxes 'required' checks; 'submit' enforces them.
 *
 * The payload shape mirrors what the filler submits: top-level field values
 * keyed by field id in `values`, plus each repeating section's rows stored as
 * an array of row value maps in `rows[sectionId]`.
 *
 * Hidden fields (showIf false) and fields in hidden sections are exempt from
 * required checks — but a supplied value must still be VALID, so a malicious
 * payload can't smuggle garbage through a hidden branch.
 */
export function validateResponse(
  schema: FormSchemaV1,
  values: FieldValueMap,
  rows: RowMap,
  stage: 'draft' | 'submit' = 'submit',
): ValidationError[] {
  const errors: ValidationError[] = []
  const ctx: EvalContext = { values, rows }

  const sectionVisible = (section: FormSection): boolean =>
    !section.showIf || evaluateLogicRule(section.showIf, ctx)

  for (const section of schema.sections) {
    const visible = sectionVisible(section)

    if (section.repeating) {
      const sectionRows = rows[section.id] ?? []
      if (!Array.isArray(sectionRows)) {
        errors.push({ fieldId: section.id, sectionId: section.id, message: 'Rows must be a list' })
        continue
      }
      if (sectionRows.length > MAX_REPEATING_ROWS) {
        errors.push({
          fieldId: section.id,
          sectionId: section.id,
          message: `No more than ${MAX_REPEATING_ROWS} rows`,
        })
        continue
      }
      if (
        stage === 'submit' &&
        visible &&
        section.minRows !== undefined &&
        sectionRows.length < section.minRows
      ) {
        errors.push({
          fieldId: section.id,
          sectionId: section.id,
          message: `Add at least ${section.minRows} row${section.minRows === 1 ? '' : 's'}`,
        })
      }
      if (section.maxRows !== undefined && sectionRows.length > section.maxRows) {
        errors.push({
          fieldId: section.id,
          sectionId: section.id,
          message: `No more than ${section.maxRows} rows`,
        })
      }

      sectionRows.forEach((row, rowIndex) => {
        // Row fields evaluate visibility against top-level values merged with
        // the row's own values (sibling fields shadow top-level ids).
        const rowCtx: EvalContext = { values: { ...values, ...row }, rows }
        for (const field of section.fields) {
          if (!isResponseValueField(field.type)) continue
          const fieldVisible =
            visible && (!field.showIf || evaluateLogicRule(field.showIf, rowCtx))
          const value = row[field.id]
          const key = `${section.id}.${rowIndex}.${field.id}`
          if (isEmpty(value)) {
            if (stage === 'submit' && fieldVisible && effectiveRequired(field)) {
              errors.push({ fieldId: key, sectionId: section.id, message: 'Required' })
            }
            continue
          }
          for (const message of fieldValueErrors(field, value)) {
            errors.push({ fieldId: key, sectionId: section.id, message })
          }
        }
      })
      continue
    }

    for (const field of section.fields) {
      if (!isResponseValueField(field.type)) continue
      const fieldVisible = visible && (!field.showIf || evaluateLogicRule(field.showIf, ctx))
      const value = values[field.id]
      if (isEmpty(value)) {
        if (stage === 'submit' && fieldVisible && effectiveRequired(field)) {
          errors.push({ fieldId: field.id, sectionId: section.id, message: 'Required' })
        }
        continue
      }
      for (const message of fieldValueErrors(field, value)) {
        errors.push({ fieldId: field.id, sectionId: section.id, message })
      }
    }
  }

  // Reject unknown top-level keys so responses can't be stuffed with
  // arbitrary payload (the jsonb column would happily store it).
  const knownIds = new Set<string>()
  for (const section of schema.sections) {
    if (section.repeating) knownIds.add(section.id)
    else for (const field of section.fields) knownIds.add(field.id)
  }
  for (const key of Object.keys(values)) {
    if (!knownIds.has(key)) {
      errors.push({ fieldId: key, message: 'Unknown field' })
    }
  }
  for (const key of Object.keys(rows)) {
    if (!knownIds.has(key)) {
      errors.push({ fieldId: key, message: 'Unknown repeating section' })
    }
  }

  return errors
}
