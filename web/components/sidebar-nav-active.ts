type ActiveNavItem = {
  href: string;
  exact?: boolean;
  /** Landing hub of the sub-menu this item belongs to — participates in
   * matching so the subgroup header highlights on its own page. */
  subgroupHref?: string;
};

type ActiveNavGroup = {
  /** Workspace module home — participates in matching (exact-only, so the
   * group header highlights on its own page without swallowing children). */
  groupHref?: string;
  items: ActiveNavItem[];
};

export function findActiveNavHref(
  pathname: string | null | undefined,
  groups: ActiveNavGroup[],
): string | null {
  if (!pathname) return null;

  let activeHref: string | null = null;

  const consider = (href: string, exact?: boolean) => {
    if (!matchesNavPath(pathname, href, exact)) return;
    if (!activeHref || href.length > activeHref.length) activeHref = href;
  };

  for (const group of groups) {
    if (group.groupHref) consider(group.groupHref, true);
    for (const item of group.items) {
      consider(item.href, item.exact);
      if (item.subgroupHref) consider(item.subgroupHref);
    }
  }

  return activeHref;
}

function matchesNavPath(location: string, href: string, exact?: boolean): boolean {
  const [pathname = "", query = ""] = location.split("?", 2);
  const [hrefPath = "", hrefQuery = ""] = href.split("?", 2);

  // Query-addressed modules share a physical page with another module. Match
  // their declared query keys without making unrelated drawer/filter params
  // part of the navigation contract.
  if (hrefQuery) {
    if (pathname !== hrefPath) return false;
    const actual = new URLSearchParams(query);
    const expected = new URLSearchParams(hrefQuery);
    for (const [key, value] of expected) if (actual.get(key) !== value) return false;
    return true;
  }

  if (pathname === hrefPath) return true;
  if (exact || hrefPath === "/") return false;
  return pathname.startsWith(hrefPath + "/");
}

/**
 * The workspace that owns a location: the one holding its menu entry, else
 * the one whose home or entries share the most leading path segments with it.
 * Pages reached inside a module (tabs, local views, record pages) are not menu
 * entries themselves but still belong to that module's workspace.
 */
export function findNavWorkspace<G extends ActiveNavGroup>(
  location: string | null | undefined,
  groups: G[],
): G | null {
  if (!location) return null;
  const activeHref = findActiveNavHref(location, groups);
  if (activeHref) {
    const owner = groups.find((group) => navGroupHrefs(group).includes(activeHref));
    if (owner) return owner;
  }
  const segments = pathSegments(location);
  let best: G | null = null;
  let bestShared = 0;
  for (const group of groups) {
    for (const href of navGroupHrefs(group)) {
      const shared = sharedLeadingSegments(segments, pathSegments(href));
      if (shared > bestShared) {
        best = group;
        bestShared = shared;
      }
    }
  }
  return best;
}

function navGroupHrefs(group: ActiveNavGroup): string[] {
  const hrefs = group.groupHref ? [group.groupHref] : [];
  for (const item of group.items) {
    hrefs.push(item.href);
    if (item.subgroupHref) hrefs.push(item.subgroupHref);
  }
  return hrefs;
}

function pathSegments(location: string): string[] {
  return (location.split("?", 1)[0] ?? "").split("/").filter(Boolean);
}

function sharedLeadingSegments(a: string[], b: string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared;
}
