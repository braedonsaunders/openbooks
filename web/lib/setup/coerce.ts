/**
 * Shared coercion/validation for Setup-registry entities. Extracted from the
 * generic CRUD route (api/admin/setup/[entity]/route.ts) so both that route AND
 * the bulk importer (lib/data-io) validate incoming values identically.
 *
 * PURE: no db/server imports. Column identifiers come only from the registry
 * (SetupField.key → toSnake), values are coerced by kind and returned as bound
 * parameter values. This is the same whitelist that keeps the generic API safe.
 */

import { normalizeDecimal, toUnits } from '@openbooks/engine/src/money/money.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/iso-date.ts'
import { SETUP_ENTITY_BY_KEY, setupFieldOptions, setupFieldVisible, toSnake, type SetupEntity, type SetupField } from './registry'
import { coveredSlotFields } from './hrm-rule-slots'
import { normalizeCountryCode } from '../countries'
import { canonicalDecimal, compareDecimal } from '../exact-decimal'
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'

/** Setup decimals include FX rates (numeric(19,10)) as well as ledger money. */
export const SETUP_DECIMAL_SCALE = 10

/** The tax-rate domain, stated once and shared with the calculation engine
 * (engine/src/tax/tax.ts): a rate is a nonnegative exact decimal with at most 4
 * decimal places — tax_rates.rate_percent is numeric(19,4), and the engine's
 * toUnits refuses anything finer. The generic percent coercer deliberately
 * accepts FX-scale (10dp) values, so this is the boundary that keeps a rate
 * the engine can actually calculate with. A statutory 0% rate is legal.
 * Returns a client error code, or null when the value is in domain. */
export function taxRatePercentProblem(raw: unknown): string | null {
  const exact = canonicalDecimal(raw, 4)
  if (exact === null) return 'invalid-tax-rate'
  try {
    if (toUnits(exact) < 0n) return 'negative-tax-rate'
  } catch {
    return 'invalid-tax-rate'
  }
  return null
}

export type Coerced = { column: string; value: unknown }

export function idColumn(entity: SetupEntity): string {
  return entity.idColumn ?? 'id'
}

/** Writable fields (everything except the multiref, which lives in a join table). */
export function scalarFields(entity: SetupEntity): SetupField[] {
  return entity.fields.filter((f) => f.kind !== 'multiref')
}

export function multirefField(entity: SetupEntity): SetupField | undefined {
  return entity.fields.find((f) => f.kind === 'multiref')
}

/**
 * Coerce and validate one field's incoming value against its kind. Returns a
 * `{ column, value }` pair, or an error string. Absent optional fields resolve
 * to null (so the column is written with its explicit empty value).
 */
export function coerceField(field: SetupField, raw: unknown, fieldVisible = true): Coerced | { error: string } {
  const present = raw !== undefined && raw !== null && raw !== ''
  // keepDefault columns are NOT NULL WITH a database default: a
  // blank is legal input that falls through to the default (each kind's
  // absent branch below resolves to null/undefined, which buildRow omits),
  // never a missing requirement. Without this the server refused the exact
  // blanks the drawer deliberately sends for untouched keepDefault inputs.
  // A field hidden by showWhen is likewise not required: the
  // drawer hides the default waiver form while enforcement is None and
  // clears it on save, so the server must accept the same blank — the
  // merged-row integrity rule still refuses a blank that is actually in
  // force.
  if (field.required && fieldVisible && !present && field.kind !== 'boolean' && !field.keepDefault) {
    return { error: `${field.key} is required` }
  }
  const column = toSnake(field.key)

  switch (field.kind) {
    case 'boolean': {
      if (present) {
        const valid = typeof raw === 'boolean'
          || (typeof raw === 'number' && (raw === 0 || raw === 1))
          || (typeof raw === 'string' && /^(true|false|yes|no|y|n|1|0|t|f)?$/i.test(raw.trim()))
        if (!valid) return { error: `${field.key} must be a boolean` }
      }
      return { column, value: coerceBoolean(raw) }
    }
    case 'integer': {
      if (!present) return { column, value: null }
      const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
      if (!Number.isSafeInteger(n)) return { error: `${field.key} must be a whole number` }
      if (field.min !== undefined && n < field.min) return { error: `${field.key} must be at least ${field.min}` }
      if (field.max !== undefined && n > field.max) return { error: `${field.key} must be at most ${field.max}` }
      return { column, value: n }
    }
    case 'decimal':
    case 'percent': {
      if (!present) return { column, value: null }
      const exact = canonicalDecimal(raw, SETUP_DECIMAL_SCALE)
      if (exact === null) return { error: `${field.key} must be a number` }
      if (field.kind === 'percent') {
        const min = field.min === undefined ? null : canonicalDecimal(String(field.min), SETUP_DECIMAL_SCALE)
        const max = field.max === undefined ? null : canonicalDecimal(String(field.max), SETUP_DECIMAL_SCALE)
        if ((field.min !== undefined && min === null) || (field.max !== undefined && max === null)) {
          return { error: `${field.key} has an invalid decimal bound` }
        }
        if (min !== null && compareDecimal(exact, min) < 0) return { error: `${field.key} must be at least ${field.min}` }
        if (max !== null && compareDecimal(exact, max) > 0) return { error: `${field.key} must be at most ${field.max}` }
      }
      try {
        return { column, value: normalizeDecimal(exact, SETUP_DECIMAL_SCALE) }
      } catch {
        return { error: `${field.key} must be a number` }
      }
    }
    case 'date': {
      if (!present) return { column, value: null }
      const s = String(raw)
      if (!isIsoCalendarDate(s)) return { error: `${field.key} must be a date` }
      return { column, value: s }
    }
    case 'select': {
      if (!present) return { column, value: field.required ? undefined : null }
      const ok = field.options?.some((o) => o.value === String(raw))
      if (!ok) return { error: `${field.key} has an invalid value` }
      return { column, value: String(raw) }
    }
    case 'country': {
      if (!present) return { column, value: null }
      const country = normalizeCountryCode(raw)
      if (!country) return { error: `${field.key} must be a valid ISO country code` }
      return { column, value: country }
    }
    case 'ref': {
      if (!present) return { column, value: null }
      const s = String(raw)
      // Refs to natural-key entities (e.g. currencies, keyed by code, or
      // hrm-document-categories with refValue 'key') carry the key itself,
      // not a uuid — the picker offers it via loadEntityOptions, so the
      // writer must accept what the picker offered.
      const target = field.ref ? SETUP_ENTITY_BY_KEY.get(field.ref) : undefined
      const naturalKeyed = field.ref === 'number-sequence-kinds'
        || (target != null && (target.idColumn ?? 'id') !== 'id')
        || (target != null && target.refValue != null)
      if (!naturalKeyed && !isUuid(s)) return { error: `${field.key} must reference a valid record` }
      return { column, value: s }
    }
    case 'stringArray': {
      // Accept a real array (the drawer's TagInput) or a JSON-encoded array
      // string (imports / API clients). jsonb arrays need JSON text as their
      // bound value, while PostgreSQL text[] columns need the native array
      // value so the driver serializes it using PostgreSQL's array format.
      let list: unknown = raw
      if (!present) list = []
      else if (typeof raw === 'string') {
        try {
          list = JSON.parse(raw)
        } catch {
          return { error: `${field.key} must be a list of text values` }
        }
      }
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
        return { error: `${field.key} must be a list of text values` }
      }
      // Deduplicate the way the engines match free text: case- and
      // whitespace-insensitive, keeping the first spelling entered.
      const seen = new Set<string>()
      const clean: string[] = []
      for (const entry of list) {
        const trimmed = entry.replace(/\s+/g, ' ').trim()
        if (!trimmed) continue
        const key = trimmed.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        clean.push(trimmed)
      }
      if (field.required && clean.length === 0) return { error: `${field.key} is required` }
      // An empty list is written as [] (the column default) — for these
      // filter columns "empty" is a real statement (everyone qualifies).
      return { column, value: field.arrayStorage === 'text' ? clean : JSON.stringify(clean) }
    }
    case 'zonedDateTime': {
      if (!present) return { column, value: null }
      const value = typeof raw === 'string' ? raw : ''
      const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
      if (!parts || !isIsoCalendarDate(parts[1]!) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59 || !Number.isFinite(Date.parse(value))) {
        return { error: `${field.key} must be an ISO timestamp with an explicit offset, for example 2026-10-01T09:00:00-04:00` }
      }
      return { column, value }
    }
    case 'object':
    case 'objectArray': {
      if (!present) return { column, value: null }
      let parsed = raw
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw) } catch { return { error: `${field.key} must contain structured values` } }
      }
      const array = field.kind === 'objectArray'
      if (array && !Array.isArray(parsed)) return { error: `${field.key} must be a list of records` }
      const entries = array ? parsed as unknown[] : [parsed]
      const values: Record<string, unknown>[] = []
      for (const [index, entry] of entries.entries()) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { error: `${field.key}${array ? ` row ${index + 1}` : ''} must be a record` }
        // Retain unrelated stored keys; editing a named control does not erase
        // other domain evidence carried by the same JSON object.
        const object = entry as Record<string, unknown>
        const value = { ...object }
        for (const child of field.fields ?? []) {
          if (!setupFieldVisible(child, object) || object[child.key] === undefined) {
            if (child.required && setupFieldVisible(child, object)) return { error: `${field.key}${array ? ` row ${index + 1}` : ''}.${child.key} is required` }
            continue
          }
          if (['text', 'textarea', 'zonedDateTime'].includes(child.kind) && typeof object[child.key] !== 'string') return { error: `${field.key}${array ? ` row ${index + 1}` : ''}.${child.key} must be text` }
          const result = coerceField(child, object[child.key])
          if ('error' in result) return { error: `${field.key}${array ? ` row ${index + 1}` : ''}: ${result.error}` }
          value[child.key] = (child.kind === 'object' || child.kind === 'objectArray' || (child.kind === 'stringArray' && child.arrayStorage !== 'text')) && typeof result.value === 'string' ? JSON.parse(result.value) : result.value
        }
        values.push(value)
      }
      // JSON text is one JSONB parameter; a driver array would become a PostgreSQL array literal.
      return { column, value: JSON.stringify(array ? values : values[0]) }
    }
    case 'json': {
      if (!present) return { column, value: null }
      if (typeof raw === 'object') return { column, value: raw }
      try {
        const value = JSON.parse(String(raw))
        if (value == null || typeof value !== 'object') return { error: `${field.key} must be a JSON object or array` }
        return { column, value }
      } catch {
        return { error: `${field.key} must be valid JSON` }
      }
    }
    case 'text':
    case 'textarea':
    default: {
      if (!present) return { column, value: null }
      return { column, value: String(raw) }
    }
  }
}

/** Decode structured transfer cells before domain integrity checks consume them.
 * The same coercer validates the shape; decoding retains the supplied keys and
 * values instead of adding defaults or substituting the coerced storage text. */
export function decodeStructuredSetupValues(
  entity: SetupEntity,
  body: Record<string, unknown>,
): { body: Record<string, unknown> } | { error: string } {
  const decoded = { ...body }
  for (const field of entity.fields) {
    if (field.kind !== 'object' && field.kind !== 'objectArray') continue
    const raw = body[field.key]
    if (raw === undefined || raw === null || raw === '') continue
    const checked = coerceField(field, raw, setupFieldVisible(field, body))
    if ('error' in checked) return checked
    decoded[field.key] = typeof raw === 'string' ? JSON.parse(raw) : raw
  }
  return { body: decoded }
}

/** Accept booleans, and the common string/number spellings from CSV/XLSX. */
export function coerceBoolean(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw
  const s = String(raw ?? '').trim().toLowerCase()
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 't'
}

/** Build the coerced column/value set for the writable scalar fields. */
export function buildRow(
  entity: SetupEntity,
  body: Record<string, unknown>,
  opts: { forCreate: boolean; coverFoldedSlots?: boolean },
): { cols: Coerced[] } | { error: string } {
  // Rule-slot prefills (ratingScaleMin/Max/Labels and kin) are never
  // written and never required once their folded object is present: the
  // normalizer stripped them and the integrity check proves the fold.
  // Opt-in per caller so import paths that never normalize keep the loud
  // required refusal instead of silently dropping the fold.
  const covered = opts.coverFoldedSlots ? coveredSlotFields(entity.key, body) : undefined
  const cols: Coerced[] = []
  for (const field of scalarFields(entity)) {
    if (covered?.has(field.key)) continue
    // On edit, natural-key / immutable columns are never rewritten.
    if (!opts.forCreate && field.lockedOnEdit) continue
    // Omission is not a negative policy choice. Apply declared defaults only
    // on creation; an update without a boolean leaves its stored value alone.
    if (!opts.forCreate && field.kind === 'boolean' && body[field.key] === undefined) continue
    const raw = opts.forCreate && body[field.key] === undefined
      ? field.defaultValue
      : body[field.key]
    // Scoped selects (pay-component treatments scoped by the component's
    // country) validate against the options that apply to THIS row — the
    // same list the drawer offered for it via setupFieldOptions.
    const scoped = field.scopedOptions ? { ...field, options: setupFieldOptions(field, body) } : field
    const res = coerceField(scoped, raw, setupFieldVisible(field, body))
    if ('error' in res) return { error: res.error }
    if (res.value === undefined) continue // required select left unset on edit → skip
    // Never write null to a NOT-NULL-with-default column: on create, omit it so
    // the DB default applies; on update, leave the existing value untouched.
    if (res.value === null && (opts.forCreate || field.keepDefault)) continue
    cols.push(res)
  }
  if (entity.key === 'tax-rates') {
    // The tax-rate domain, enforced for every buildRow caller — including the
    // bulk importer, which never runs the interactive writer's merged-row
    // integrity check. The generic percent coercer admits FX-scale (10dp)
    // values that numeric(19,4) silently rounds on storage, so an explicitly
    // supplied out-of-domain rate is refused here with the same codes the
    // interactive path returns. A blank on update keeps the stored rate and
    // is not checked.
    const raw = body.ratePercent
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      const problem = taxRatePercentProblem(raw)
      if (problem) return { error: problem }
    }
  }
  return { cols }
}

/** Drizzle wraps node-postgres failures in DrizzleQueryError with the driver
 * error as `cause`; surface the driver's SQLSTATE either way so callers can
 * map constraint violations deterministically. */
export function pgErrorCode(e: unknown): string | undefined {
  const error = e as { code?: string; cause?: { code?: string } }
  return error?.code ?? error?.cause?.code
}

/** The driver failure's constraint/index name (e.g. a unique index), digging
 * through the Drizzle wrapper the same way pgErrorCode does, so callers can
 * map a violation deterministically instead of substring-matching text. */
export function pgErrorConstraint(e: unknown): string | undefined {
  const error = e as { constraint?: string; cause?: { constraint?: string } }
  return error?.constraint ?? error?.cause?.constraint
}
/**
 * Residual storage-shape refusal for the review-template rating scale.
 * The input boundary coerces decimal strings to numbers and the engine
 * proves the shape before the write, so reaching the CHECK means a
 * defense layer was bypassed or drifted — still a named client refusal,
 * never the raw CHECK text. The CHECK itself stays intact.
 */
export function scaleShapeCheckRefusal(
  entityKey: string,
  e: unknown,
): { status: 400; body: { error: string; code: 'invalid' } } | null {
  if (entityKey !== 'hrm-review-templates') return null
  if (pgErrorCode(e) !== '23514') return null
  const error = e as { constraint?: unknown; cause?: { constraint?: unknown } }
  const constraint = error?.cause?.constraint ?? error?.constraint
  if (constraint !== 'hrm_review_templates_scale_shape') return null
  return {
    status: 400,
    body: {
      error:
        'the review template rating scale min and max must be numbers with min below max — fix the scale fields before saving',
      code: 'invalid',
    },
  }
}

const CARRIER_TRACKING_EXAMPLE = 'https://carrier.example/track?number={tracking}'

/**
 * A carrier's tracking-link template, checked as it will be stored: blank
 * means no tracking link; otherwise a web address (it becomes a link on the
 * shipment and in the customer's tracking email) holding `{tracking}` where
 * the tracking number is substituted. Returns the refusal, or null.
 */
export function carrierTrackingTemplateProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const template = String(raw)
  if (!/^https?:\/\/\S+$/i.test(template)) {
    return `A tracking link template must be a web address starting with https:// or http://, for example ${CARRIER_TRACKING_EXAMPLE}`
  }
  if (!template.includes('{tracking}')) {
    return `A tracking link template must contain {tracking} where the tracking number goes, for example ${CARRIER_TRACKING_EXAMPLE}`
  }
  return null
}

const CARRIER_CHECK_REFUSALS: Record<string, string> = {
  carriers_services_check: 'A carrier needs at least one service: enter the service levels it offers, such as Ground',
  carriers_tracking_url_template_check:
    `A tracking link template must contain {tracking} where the tracking number goes, for example ${CARRIER_TRACKING_EXAMPLE}`,
  carriers_code_check: 'A carrier needs a code',
  carriers_name_check: 'A carrier needs a name',
}

/**
 * Residual storage refusal for carriers. The coercer and the integrity check
 * name these before the write; reaching a CHECK means a defense layer was
 * bypassed or drifted, and the answer is still the named refusal rather
 * than the raw constraint text.
 */
export function carrierCheckRefusal(
  entityKey: string,
  e: unknown,
): { status: 400; body: { error: string; code: 'invalid' } } | null {
  if (entityKey !== 'carriers' || pgErrorCode(e) !== '23514') return null
  const message = CARRIER_CHECK_REFUSALS[pgErrorConstraint(e) ?? '']
  return message ? { status: 400, body: { error: message, code: 'invalid' } } : null
}

/** Translate a few common Postgres error codes into stable, client-friendly strings. */
export function describeDbError(e: unknown): string {
  const code = pgErrorCode(e)
  if (code === '23505') return 'duplicate' // unique_violation
  if (code === '23503') return 'in-use' // foreign_key_violation
  if (code === '23502') return 'missing-required' // not_null_violation
  // Drizzle wraps driver failures in DrizzleQueryError whose own message
  // embeds the FULL SQL text plus bound params (a raw INSERT once reached
  // the dialog this way) — never echo the wrapper. The driver's
  // message (cause) is plain Postgres text, e.g. a trigger's user-language
  // refusal; anything else degrades to a generic failure, never SQL.
  const driverMessage = (e as { cause?: { message?: unknown } })?.cause?.message
  if (typeof driverMessage === 'string' && driverMessage.length > 0) return driverMessage
  const message = (e as { message?: unknown; query?: unknown })?.message
  if (typeof message === 'string' && message.length > 0 && (e as { query?: unknown })?.query === undefined) return message
  return 'save failed'
}
