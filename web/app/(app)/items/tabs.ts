export type ItemsWorkspaceTab = 'catalog' | 'rate-books' | 'families'

/**
 * One route strip for the item catalog, rate books, and product families.
 * Feature-disabled destinations are omitted so the strip never offers a route
 * the viewer cannot open. A lone Families tab is paired with the catalog it
 * was reached from, because the strip renders nothing for a single tab.
 */
export function itemsWorkspaceTabs({
  active,
  catalogLabel,
  rateBooksLabel,
  familiesLabel,
  showRateBooks,
  showFamilies,
}: {
  active: ItemsWorkspaceTab
  catalogLabel: string
  rateBooksLabel: string
  familiesLabel: string
  showRateBooks: boolean
  showFamilies: boolean
}): { href: string; label: string; active: boolean }[] {
  const catalog = { href: '/items', label: catalogLabel, active: active === 'catalog' }
  const tabs = [
    ...(showRateBooks
      ? [
          catalog,
          { href: '/items?view=rate-books', label: rateBooksLabel, active: active === 'rate-books' },
        ]
      : []),
    ...(showFamilies
      ? [{ href: '/items/families', label: familiesLabel, active: active === 'families' }]
      : []),
  ]
  return tabs.length === 1 ? [catalog, ...tabs] : tabs
}
