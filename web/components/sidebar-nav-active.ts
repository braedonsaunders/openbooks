type ActiveNavItem = {
  href: string
  exact?: boolean
  /** Landing hub of the sub-menu this item belongs to — participates in
   * matching so the subgroup header highlights on its own page. */
  subgroupHref?: string
}

type ActiveNavGroup = {
  /** Workspace module home — participates in matching (exact-only, so the
   * group header highlights on its own page without swallowing children). */
  groupHref?: string
  items: ActiveNavItem[]
}

export function findActiveNavHref(
  pathname: string | null | undefined,
  groups: ActiveNavGroup[],
): string | null {
  if (!pathname) return null

  let activeHref: string | null = null

  const consider = (href: string, exact?: boolean) => {
    if (!matchesNavPath(pathname, href, exact)) return
    if (!activeHref || href.length > activeHref.length) activeHref = href
  }

  for (const group of groups) {
    if (group.groupHref) consider(group.groupHref, true)
    for (const item of group.items) {
      consider(item.href, item.exact)
      if (item.subgroupHref) consider(item.subgroupHref)
    }
  }

  return activeHref
}

function matchesNavPath(location: string, href: string, exact?: boolean): boolean {
  const [pathname = '', query = ''] = location.split('?', 2)
  const [hrefPath = '', hrefQuery = ''] = href.split('?', 2)

  // Query-addressed modules share a physical page with another module. Match
  // their declared query keys without making unrelated drawer/filter params
  // part of the navigation contract.
  if (hrefQuery) {
    if (pathname !== hrefPath) return false
    const actual = new URLSearchParams(query)
    const expected = new URLSearchParams(hrefQuery)
    for (const [key, value] of expected) if (actual.get(key) !== value) return false
    return true
  }

  if (pathname === hrefPath) return true
  if (exact || hrefPath === '/') return false
  return pathname.startsWith(hrefPath + '/')
}
