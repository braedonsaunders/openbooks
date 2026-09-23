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

/**
 * Reconcile two whole-layout states after an optimistic-concurrency conflict:
 * the union of both tabs' hides, ordered by the local tab's latest order with
 * any server-only keys appended in server order. Unioning (never intersecting)
 * means neither tab's hide is silently dropped: when the tabs disagree on a
 * key, hidden wins and the operator sees it — unhiding again is one explicit
 * toggle away, while a dropped hide would reappear only as a mystery on the
 * next reload.
 */
export function mergePageLayouts(
  server: PageLayoutPrefs,
  local: PageLayoutPrefs,
): PageLayoutPrefs {
  const hidden = [...new Set([...(server.hidden ?? []), ...(local.hidden ?? [])])]
  const localOrder = local.order ?? []
  const localSet = new Set(localOrder)
  const order = [...localOrder, ...(server.order ?? []).filter((k) => !localSet.has(k))]
  return {
    ...(order.length > 0 ? { order } : {}),
    ...(hidden.length > 0 ? { hidden } : {}),
  }
}
