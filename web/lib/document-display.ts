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
