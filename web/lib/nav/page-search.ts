import type { SidebarNavGroup } from '../../components/sidebar-nav'
import type { ViewTabGroup } from '../../components/module-home/view-tab-match'

/**
 * Page search for the global search bar.
 *
 * The index is built only from navigation the shell has already resolved for
 * the reader: the main menu (permission- and feature-gated, with the
 * organization's renames and the reader's locale applied) and the workspace
 * tab strips. A page the menu hides can therefore never appear here, and a
 * renamed menu entry is found by the name the reader actually sees.
 */
export type PageSearchHit = {
  href: string
  title: string
  /** Where the page lives in the menu, outermost first. */
  trail: string[]
  iconKey: string
}

type Entry = PageSearchHit & { order: number; titleKey: string; trailKey: string }

export const PAGE_SEARCH_LIMIT = 6

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

function pathOf(href: string): string {
  return href.split(/[?#]/)[0] ?? href
}

/** Every navigable page the reader can see, in menu order, one entry per href. */
export function buildPageIndex(
  groups: readonly SidebarNavGroup[],
  tabGroups: readonly ViewTabGroup[] = [],
): PageSearchHit[] {
  const entries = new Map<string, PageSearchHit>()
  const add = (hit: PageSearchHit) => {
    if (!hit.title.trim() || entries.has(hit.href)) return
    entries.set(hit.href, hit)
  }

  for (const group of groups) {
    if (group.groupHref) add({ href: group.groupHref, title: group.label, trail: [], iconKey: group.iconKey })
    for (const item of group.items) {
      if (item.subgroup && item.subgroupHref) {
        add({
          href: item.subgroupHref,
          title: item.subgroup,
          trail: [group.label],
          iconKey: item.subgroupIconKey ?? item.iconKey,
        })
      }
      add({
        href: item.href,
        title: item.label,
        trail: item.subgroup ? [group.label, item.subgroup] : [group.label],
        iconKey: item.iconKey,
      })
    }
  }

  // A workspace tab is placed under the menu entry that opens its strip, so
  // a generic tab name ("Settings", "Overview") still reads unambiguously.
  const menuByPath = new Map<string, PageSearchHit>()
  for (const hit of entries.values()) {
    const path = pathOf(hit.href)
    if (!menuByPath.has(path)) menuByPath.set(path, hit)
  }
  for (const tabs of tabGroups) {
    const parent = tabs.map((tab) => menuByPath.get(pathOf(tab.href))).find(Boolean)
    for (const tab of tabs) {
      add({
        href: tab.href,
        title: tab.label,
        trail: parent ? [...parent.trail, parent.title] : [],
        iconKey: parent?.iconKey ?? 'link',
      })
    }
  }

  return [...entries.values()]
}

/**
 * How well the query names the page: 0 is an exact name, higher is weaker,
 * -1 is no match. Every query word must appear in the page name or its menu trail,
 * and at least one in the name itself, so "payroll settings" finds the
 * Settings tab of Payroll while "accounting" does not list every page under
 * the Accounting menu (its home page is the match).
 */
function rank(entry: Entry, words: string[], phrase: string): number {
  const title = entry.titleKey
  if (title === phrase) return 0
  if (title.startsWith(phrase)) return 1
  if (` ${title}`.includes(` ${phrase}`)) return 2
  if (title.includes(phrase)) return 3
  if (words.every((word) => title.includes(word))) return 4
  const anywhere = `${title} ${entry.trailKey}`
  if (words.some((word) => title.includes(word)) && words.every((word) => anywhere.includes(word))) return 5
  return -1
}

export function searchPages(index: readonly PageSearchHit[], query: string, limit = PAGE_SEARCH_LIMIT): PageSearchHit[] {
  const phrase = fold(query).replace(/\s+/g, ' ')
  const words = phrase.split(' ').filter(Boolean)
  if (words.length === 0) return []
  return index
    .map((hit, order): Entry => ({ ...hit, order, titleKey: fold(hit.title), trailKey: fold(hit.trail.join(' ')) }))
    .map((entry) => ({ entry, score: rank(entry, words, phrase) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || a.entry.order - b.entry.order)
    .slice(0, limit)
    .map(({ entry: { href, title, trail, iconKey } }) => ({ href, title, trail, iconKey }))
}
