/** Editor-only choices never become stored dimension values. */
export const INHERIT_SEGMENT = '__inherit__'
export const CLEAR_SEGMENT = '__clear__'

export function segmentCellValue(assignments: Record<string, unknown> | null, key: string): unknown {
  return assignments && Object.hasOwn(assignments, key)
    ? assignments[key] === null ? CLEAR_SEGMENT : assignments[key]
    : INHERIT_SEGMENT
}

/** Omission inherits; a deliberate blank retains its key as a null override. */
export function segmentAssignmentsFromCells(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => {
    const value = row[`seg_${key}`]
    if (value === undefined || value === INHERIT_SEGMENT) return []
    return [[key, value === '' || value === null || value === CLEAR_SEGMENT ? null : value]]
  }))
}
