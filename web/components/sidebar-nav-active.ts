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

function matchesNavPath(pathname: string, href: string, exact?: boolean): boolean {
  if (pathname === href) return true
  if (exact || href === '/') return false
  return pathname.startsWith(href + '/')
}
