/**
 * Client-safe segment naming helpers (F-t07-009).
 *
 * The four reportable built-in segments ship with fixed seed names (migration
 * V0098) but the tenant may rename them. Translating a renamed segment's
 * name would corrupt tenant data, so catalog translations apply only while
 * the names still match the seed — a renamed segment renders verbatim and
 * its "All X" option falls back to `All {pluralName}`.
 */

export type SegmentNameRef = {
  key: string
  name: string
  pluralName: string
}

/** Seed (un-renamed) names of the reportable built-in segments. */
export const BUILTIN_SEGMENT_SEED: Record<string, { name: string; pluralName: string }> = {
  department: { name: 'Department', pluralName: 'Departments' },
  project: { name: 'Project', pluralName: 'Projects' },
  location: { name: 'Location', pluralName: 'Locations' },
  class: { name: 'Class', pluralName: 'Classes' },
}

export type BuiltinSegmentKey = 'department' | 'project' | 'location' | 'class'

/** Fully-translated `filterBar` key for the "All X" option of each default segment. */
export const DEFAULT_SEGMENT_ALL_KEY: Record<BuiltinSegmentKey, string> = {
  department: 'allDepartments',
  project: 'allProjects',
  location: 'allLocations',
  class: 'allClasses',
}

/** True when the segment still carries its seed names — safe to translate. */
export function isDefaultSegmentName(seg: SegmentNameRef | null | undefined): boolean {
  if (!seg) return false
  const seed = BUILTIN_SEGMENT_SEED[seg.key]
  return !!seed && seg.name === seed.name && seg.pluralName === seed.pluralName
}
