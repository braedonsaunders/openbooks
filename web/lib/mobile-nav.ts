import type { SidebarNavGroup } from '../components/sidebar-nav'

/** Tenant-pinned shortcuts first, then permission-visible destinations in
 * workspace order. The fallback keeps the bar useful when some pinned modules
 * are unavailable to the current role. */
export function selectMobileTabs(groups: SidebarNavGroup[], count = 4) {
  const unique = groups
    .flatMap((group) => group.items)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.href === item.href) === index)
  return [...unique.filter((item) => item.mobile), ...unique.filter((item) => !item.mobile)].slice(0, count)
}
