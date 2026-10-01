import { CELL_PROVENANCE_KEY, SOURCE_COLUMNS_KEY, UNMAPPED_COLUMNS_KEY, type CellProvenance } from './types'

export function duplicateMappingTarget(
  mapping: Record<string, string>,
): { field: string; sources: [string, string] } | null {
  const firstSource = new Map<string, string>()
  for (const [source, field] of Object.entries(mapping)) {
    if (!field) continue
    const first = firstSource.get(field)
    if (first !== undefined) return { field, sources: [first, source] }
    firstSource.set(field, source)
  }
  return null
}

/** Map a raw source row (keyed by file header) onto field-keyed values. */
export function applyMapping(raw: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const mapped = new Set<string>()
  const sources: Record<string, string> = {}
  const rawProvenance = raw[CELL_PROVENANCE_KEY]
  const sourceProvenance =
    rawProvenance !== null && typeof rawProvenance === 'object' && !Array.isArray(rawProvenance)
      ? rawProvenance as Record<string, unknown>
      : null
  const mappedProvenance: Record<string, CellProvenance> = {}
  for (const [source, field] of Object.entries(mapping)) {
    if (!field) continue
    out[field] = raw[source]
    mapped.add(source)
    sources[field] = source
    if (sourceProvenance?.[source] === 'formula') mappedProvenance[source] = 'formula'
  }
  if (Object.keys(sources).length > 0) out[SOURCE_COLUMNS_KEY] = sources
  if (Object.keys(mappedProvenance).length > 0) {
    out[CELL_PROVENANCE_KEY] = mappedProvenance
  }
  // Header → its raw value, so a resource can tell "unmapped and empty" from
  // "unmapped and carrying money". Nested under the reserved key rather than
  // spread into the row: a source header that happens to be spelled like a
  // field key must never supply a value for that field.
  const unmapped: Record<string, unknown> = {}
  for (const header of Object.keys(raw)) {
    if (header === CELL_PROVENANCE_KEY) continue
    if (!mapped.has(header)) unmapped[header] = raw[header]
  }
  if (Object.keys(unmapped).length > 0) out[UNMAPPED_COLUMNS_KEY] = unmapped
  return out
}

/** Auto-guess a target field for a source header (exact, case-insensitive, fuzzy). */
export function guessMapping(headers: string[], fieldKeys: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byNorm = new Map(fieldKeys.map((k) => [norm(k), k]))
  const mapping: Record<string, string> = {}
  for (const h of headers) {
    const n = norm(h)
    if (byNorm.has(n)) mapping[h] = byNorm.get(n)!
  }
  return mapping
}
