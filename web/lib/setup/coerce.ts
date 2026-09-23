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
import { SETUP_ENTITY_BY_KEY, setupFieldOptions, setupFieldVisible, toSnake, type SetupEntity, type SetupField } from './registry'
import { normalizeCountryCode } from '../countries'
import { canonicalDecimal } from '../exact-decimal'

/** Setup decimals include FX rates (numeric(19,10)) as well as ledger money. */
const SETUP_DECIMAL_SCALE = 10

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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Strict YYYY-MM-DD calendar check: shape alone admits impossible dates
 * ('2024-02-30', month 13) that PostgreSQL then refuses with a driver error
 * instead of the field's documented client error. Same boundary as the
 * custom-field date validator (isIsoCalendarDate) and the forms-core response
 * validator. Pure — this module must stay free of db imports.
 */
export function isCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day <= daysInMonth
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
  // keepDefault columns are NOT NULL WITH a database default (F-t06-022): a
  // blank is legal input that falls through to the default (each kind's
  // absent branch below resolves to null/undefined, which buildRow omits),
  // never a missing requirement. Without this the server refused the exact
  // blanks the drawer deliberately sends for untouched keepDefault inputs.
  // A field hidden by showWhen is likewise not required (F-t03-007): the
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
        const n = Number(exact)
        if (field.min !== undefined && n < field.min) return { error: `${field.key} must be at least ${field.min}` }
        if (field.max !== undefined && n > field.max) return { error: `${field.key} must be at most ${field.max}` }
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
      if (!isCalendarDate(s)) return { error: `${field.key} must be a date` }
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
      if (!naturalKeyed && !UUID_RE.test(s)) return { error: `${field.key} must reference a valid record` }
      return { column, value: s }
    }
    case 'stringArray': {
      // A jsonb text[] column. Accept a real array (the drawer's TagInput) or
      // a JSON-encoded array string (imports / API clients). The bound value
      // is a JSON STRING, never a JS array — node-postgres renders a JS array
      // as a Postgres array literal ({"a","b"}), which is invalid jsonb.
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
      return { column, value: JSON.stringify(clean) }
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
  opts: { forCreate: boolean },
): { cols: Coerced[] } | { error: string } {
  const cols: Coerced[] = []
  for (const field of scalarFields(entity)) {
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
  return { cols }
}

/** Drizzle wraps node-postgres failures in DrizzleQueryError with the driver
 * error as `cause`; surface the driver's SQLSTATE either way so callers can
 * map constraint violations deterministically. */
export function pgErrorCode(e: unknown): string | undefined {
  const error = e as { code?: string; cause?: { code?: string } }
  return error?.code ?? error?.cause?.code
}

/** Translate a few common Postgres error codes into stable, client-friendly strings. */
export function describeDbError(e: unknown): string {
  const code = pgErrorCode(e)
  if (code === '23505') return 'duplicate' // unique_violation
  if (code === '23503') return 'in-use' // foreign_key_violation
  if (code === '23502') return 'missing-required' // not_null_violation
  // Drizzle wraps driver failures in DrizzleQueryError whose own message
  // embeds the FULL SQL text plus bound params (F-t06-022 leaked a raw
  // INSERT to the dialog this way) — never echo the wrapper. The driver's
  // message (cause) is plain Postgres text, e.g. a trigger's user-language
  // refusal; anything else degrades to a generic failure, never SQL.
  const driverMessage = (e as { cause?: { message?: unknown } })?.cause?.message
  if (typeof driverMessage === 'string' && driverMessage.length > 0) return driverMessage
  const message = (e as { message?: unknown; query?: unknown })?.message
  if (typeof message === 'string' && message.length > 0 && (e as { query?: unknown })?.query === undefined) return message
  return 'save failed'
}
