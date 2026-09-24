export type ExportColumnSelection<T extends { key: string; label: string }> =
  | { ok: true; columns: T[] }
  | { ok: false; error: string }

/** A bad or stale column request must never widen into a full export. */
export function selectExportColumns<T extends { key: string; label: string }>(
  available: T[],
  requested: unknown,
): ExportColumnSelection<T> {
  if (requested === undefined) return { ok: true, columns: available }
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, error: 'columns must include at least one known column' }
  }
  const known = new Set(available.map((column) => column.key))
  const unknown = [...new Set(requested.filter((key) => typeof key !== 'string' || !known.has(key)))]
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown export columns: ${unknown.map(String).join(', ')}`,
    }
  }
  const selected = new Set(requested as string[])
  return { ok: true, columns: available.filter((column) => selected.has(column.key)) }
}
