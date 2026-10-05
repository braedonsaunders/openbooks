/**
 * The workspace Locations tab shows one concept at a time: the mapped
 * locations (the parent body), or the per-item policies. Stock conflicts
 * belong to one mapped location, so they open from its row in a drawer
 * rather than stacking a second table. Anything unknown is the mapped
 * list.
 */
export type LocationSectionKey = 'mapped' | 'policies'

export function resolveLocationSection(
  sp: Record<string, string | string[] | undefined>,
): LocationSectionKey {
  return sp.section === 'policies' ? 'policies' : 'mapped'
}

export function conflictsForLocation<T extends { stockLocationId: string }>(
  conflicts: readonly T[],
  stockLocationId: string | null,
): T[] {
  if (!stockLocationId) return []
  return conflicts.filter((conflict) => conflict.stockLocationId === stockLocationId)
}
