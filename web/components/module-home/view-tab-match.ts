import type { ModuleHomeTab } from './tab-types'

/**
 * One sibling view of a job: a route, or a `?param=` view of a route.
 *
 * `prefix` keeps the tab lit on child routes (a compensation cycle under
 * Compensation). `carry` names the query params that survive a switch
 * between two views of the SAME route — the status filter while moving
 * between recruiting views — and are never sent to a different route,
 * where they would mean something else.
 */
export type ViewTab = {
  href: string
  label: string
  prefix?: boolean
  carry?: string[]
  /** Only named organization lenses can travel to a different sibling route. */
  sharedCarry?: string[]
  navigationSet?: string
}

/** A job's sibling views, in strip order. */
export type ViewTabGroup = ViewTab[]

/** Route ownership survives hiding a destination from its local strip. */
export type ViewTabOwnership = { href: string; prefix?: boolean; group: number }

function split(href: string): { path: string; query: URLSearchParams } {
  const [path = href, query = ''] = href.split('?')
  return { path, query: new URLSearchParams(query) }
}

/**
 * How specifically a tab names the current location, or -1 when it does
 * not. A longer route beats a shorter prefix (Equity over Compensation on
 * /hrm/compensation/equity), and a matching `?tab=` beats the bare route
 * (Interviews over Openings) — so an unknown or retired `?tab=` value falls
 * back to the bare route's tab instead of lighting nothing.
 */
function score(tab: ViewTab, pathname: string, search: URLSearchParams): number {
  const { path, query } = split(tab.href)
  const onPath = pathname === path || (tab.prefix === true && pathname.startsWith(`${path}/`))
  if (!onPath) return -1
  let matched = 0
  for (const [key, value] of query) {
    if (search.get(key) !== value) return -1
    matched += 1
  }
  return path.length * 100 + matched
}

function withCarry(tab: ViewTab, pathname: string, search: URLSearchParams): string {
  const { path, query } = split(tab.href)
  const keys = path === pathname ? tab.carry : tab.sharedCarry
  if (!keys?.length) return tab.href
  for (const key of keys) {
    const value = search.get(key)
    if (value !== null && !query.has(key)) query.set(key, value)
  }
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

/**
 * The strip for the current location: the group holding the best-matching
 * tab, with that tab active. Null when no group owns the location — a page
 * outside every job renders no strip at all — and when the viewer can open
 * only one of the job's views, since one tab switches nothing.
 */
export function resolveViewTabs(
  groups: readonly ViewTabGroup[],
  pathname: string,
  search: URLSearchParams,
  ownership?: readonly ViewTabOwnership[],
): ModuleHomeTab[] | null {
  let best: { group: ViewTabGroup; index: number; score: number } | null = null
  for (const group of groups) {
    for (const [index, tab] of group.entries()) {
      const s = score(tab, pathname, search)
      if (s >= 0 && (best === null || s > best.score)) best = { group, index, score: s }
    }
  }
  if (best === null && ownership) {
    const owner = ownership.filter((route) => {
      const path = split(route.href).path
      return path === pathname || (route.prefix && pathname.startsWith(`${path}/`))
    }).sort((a, b) => split(b.href).path.length - split(a.href).path.length)[0]
    const group = owner && groups[owner.group]
    if (group) best = { group, index: -1, score: -1 }
  }
  if (best === null || best.group.length < 2) return null
  const { group, index } = best
  return group.map((tab, i) => ({
    href: withCarry(tab, pathname, search),
    label: tab.label,
    active: i === index,
  }))
}
