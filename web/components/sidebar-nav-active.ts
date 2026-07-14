type ActiveNavItem = {
  href: string
  exact?: boolean
}

type ActiveNavGroup = {
  items: ActiveNavItem[]
}

export function findActiveNavHref(
  pathname: string | null | undefined,
  groups: ActiveNavGroup[],
): string | null {
  if (!pathname) return null

  let activeHref: string | null = null

  for (const group of groups) {
    for (const item of group.items) {
      if (!matchesNavPath(pathname, item)) continue
      if (!activeHref || item.href.length > activeHref.length) {
        activeHref = item.href
      }
    }
  }

  return activeHref
}

function matchesNavPath(pathname: string, item: ActiveNavItem): boolean {
  if (pathname === item.href) return true
  if (item.exact || item.href === '/') return false
  return pathname.startsWith(item.href + '/')
}
