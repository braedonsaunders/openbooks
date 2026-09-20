/**
 * Customer-facing document numbers (F-t12-004).
 *
 * Mirrored rows can carry the sync source handle (e.g.
 * 'salesInvoice:<uuid>') in document_number when the source never
 * supplied a number. A handle is never shown: display falls back to the
 * reference. Client-safe (no server-only import) for drawer titles; the
 * SQL twin is DISPLAY_DOCUMENT_NUMBER_EXPR in
 * web/lib/customization/list-query.ts — keep the predicate in sync.
 */

const SOURCE_HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9]*:[0-9a-fA-F-]{36}$/

export function isSourceHandle(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_HANDLE_PATTERN.test(value)
}

export function displayDocumentNumber(documentNumber: unknown, referenceNumber: unknown): string {
  if (!isSourceHandle(documentNumber)) return typeof documentNumber === 'string' ? documentNumber : ''
  return typeof referenceNumber === 'string' && referenceNumber !== '' ? referenceNumber : documentNumber
}

/**
 * Seeded built-in form name (F-t02-013).
 *
 * New orgs get one record form layout per record type named exactly this
 * (engine/src/provisioning/customization-defaults.ts DEFAULT_FORM_NAME). The name is
 * data, not chrome — but while it still carries the seed name AND is the
 * default, drawers show the translated "Default form" instead of leaking
 * English into localized chrome. Either condition alone shows the stored
 * name: a renamed default is custom copy, and a non-default layout that
 * happens to share the seed name is a user record.
 */
export const SEEDED_DEFAULT_FORM_NAME = 'Default form'

export function displayFormName(
  name: string,
  isDefault: boolean | undefined,
  translatedDefault: string,
): string {
  return isDefault === true && name === SEEDED_DEFAULT_FORM_NAME ? translatedDefault : name
}
