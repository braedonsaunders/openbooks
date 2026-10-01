import type { LocalNavigationPreferences } from '@openbooks/engine/navigation'

/** Links must remain explicit paths or HTTPS destinations, never protocol-relative URLs. */
export function safeNavigationHref(href: string): boolean {
  if (/[\\\u0000-\u0020\u007f]/.test(href)) return false
  if (href.startsWith('/')) return !href.startsWith('//')
  try {
    const url = new URL(href)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Validate choices against the live native/installed catalog, never user-provided access metadata. */
export function validLocalNavigationPreferences(
  preferences: LocalNavigationPreferences | undefined,
  catalog: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!preferences) return true
  let count = 0
  for (const [key, preference] of Object.entries(preferences)) {
    const hrefs = catalog.get(key)
    if (!hrefs || !Array.isArray(preference.items)) return false
    const seen = new Set<string>()
    for (const item of preference.items) {
      if (!hrefs.has(item.href) || seen.has(item.href) || (item.label !== undefined && (!item.label.trim() || item.label.length > 100))) return false
      seen.add(item.href)
      if (++count > 256) return false
    }
  }
  return true
}
