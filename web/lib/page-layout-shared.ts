import type { PageLayoutPrefs } from '@openbooks/schema'

/**
 * Resolve display order for a customizable page: the user's saved order first
 * (unknown keys dropped), then any panels the pref predates, in default
 * order — new panels ship visible without touching saved rows. Pure and
 * client-safe (the server page and the cockpit's customize UI share it).
 */
export function orderPanels(defaultOrder: readonly string[], prefs: PageLayoutPrefs): string[] {
  const known = new Set(defaultOrder)
  const saved = (prefs.order ?? []).filter((k) => known.has(k))
  const savedSet = new Set(saved)
  return [...saved, ...defaultOrder.filter((k) => !savedSet.has(k))]
}
