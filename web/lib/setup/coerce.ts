/**
 * Shared coercion/validation for Setup-registry entities. Extracted from the
 * generic CRUD route (api/admin/setup/[entity]/route.ts) so both that route AND
 * the bulk importer (lib/data-io) validate incoming values identically.
 *
 * PURE: no db/server imports. Column identifiers come only from the registry
 * (SetupField.key → toSnake), values are coerced by kind and returned as bound
 * parameter values. This is the same whitelist that keeps the generic API safe.
 */

import { SETUP_ENTITY_BY_KEY, toSnake, type SetupEntity, type SetupField } from './registry'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
export function coerceField(field: SetupField, raw: unknown): Coerced | { error: string } {
  const present = raw !== undefined && raw !== null && raw !== ''
  if (field.required && !present && field.kind !== 'boolean') {
    return { error: `${field.key} is required` }
  }
  const column = toSnake(field.key)

  switch (field.kind) {
    case 'boolean':
      return { column, value: coerceBoolean(raw) }
    case 'integer': {
      if (!present) return { column, value: null }
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: `${field.key} must be a whole number` }
      return { column, value: n }
    }
    case 'decimal':
    case 'percent': {
      if (!present) return { column, value: null }
      const n = Number(raw)
      if (!Number.isFinite(n)) return { error: `${field.key} must be a number` }
      // numeric columns accept a string; keep full precision
      return { column, value: String(raw) }
    }
    case 'date': {
      if (!present) return { column, value: null }
      const s = String(raw)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: `${field.key} must be a date` }
      return { column, value: s }
    }
    case 'select': {
      if (!present) return { column, value: field.required ? undefined : null }
      const ok = field.options?.some((o) => o.value === String(raw))
      if (!ok) return { error: `${field.key} has an invalid value` }
      return { column, value: String(raw) }
    }
    case 'ref': {
      if (!present) return { column, value: null }
      const s = String(raw)
      // Refs to natural-key entities (e.g. currencies, keyed by code) carry the
      // key itself, not a uuid.
      const target = field.ref ? SETUP_ENTITY_BY_KEY.get(field.ref) : undefined
      const naturalKeyed = target != null && (target.idColumn ?? 'id') !== 'id'
      if (!naturalKeyed && !UUID_RE.test(s)) return { error: `${field.key} must reference a valid record` }
      return { column, value: s }
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
    const res = coerceField(field, body[field.key])
    if ('error' in res) return { error: res.error }
    if (res.value === undefined) continue // required select left unset on edit → skip
    // Never write null to a NOT-NULL-with-default column: on create, omit it so
    // the DB default applies; on update, leave the existing value untouched.
    if (res.value === null && (opts.forCreate || field.keepDefault)) continue
    cols.push(res)
  }
  return { cols }
}

/** Translate a few common Postgres error codes into stable, client-friendly strings. */
export function describeDbError(e: unknown): string {
  const code = (e as { code?: string })?.code
  if (code === '23505') return 'duplicate' // unique_violation
  if (code === '23503') return 'in-use' // foreign_key_violation
  if (code === '23502') return 'missing-required' // not_null_violation
  return (e as { message?: string })?.message ?? 'save failed'
}
