/** Each nested setup record owns its tab and descendant URL state. */
export function setupNavigationKeys(prefix?: string) {
  const childPrefix = prefix ? `${prefix}Child` : 'child'
  return { tab: prefix ? `${prefix}Tab` : 'setupTab', childPrefix, childRow: `${childPrefix}Row` }
}

export function clearSetupChildren(params: URLSearchParams, prefix?: string): void {
  const { childPrefix } = setupNavigationKeys(prefix)
  for (const key of [...params.keys()]) {
    if (key === `${childPrefix}Row` || key === `${childPrefix}Q` || key === `${childPrefix}Page` || key === `${childPrefix}ShowInactive` || key === `${childPrefix}Tab` || key.startsWith(`${childPrefix}Child`)) params.delete(key)
  }
}

export function setupTabParams(params: URLSearchParams, tab: string, prefix?: string): URLSearchParams {
  const next = new URLSearchParams(params)
  const keys = setupNavigationKeys(prefix)
  if (tab !== next.get(keys.tab)) clearSetupChildren(next, prefix)
  if (tab === 'details') {
    next.delete(keys.tab)
    clearSetupChildren(next, prefix)
    if (!prefix) for (const key of ['boxRow', 'rateRow', 'valueRow']) next.delete(key)
  } else next.set(keys.tab, tab)
  return next
}
