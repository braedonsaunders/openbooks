import { LOCAL_NAVIGATION, applyLocalNavigationPreferences, type LocalNavigationPreferences } from '@openbooks/engine/navigation'
import type { ModuleHomeTab } from './tab-types'

/** Preserve page-owned counts and access choices while applying shared preferences. */
export function configureInlineTabs(tabs: ModuleHomeTab[], preferences?: LocalNavigationPreferences): ModuleHomeTab[] {
  if (!preferences || !tabs.length) return tabs
  const identities = tabs.map((tab) => {
    const url = new URL(tab.href, 'https://navigation.invalid')
    const candidates = LOCAL_NAVIGATION.filter((set) => set.inline).flatMap((set) => set.tabs.map((choice) => ({ set, choice })))
      .filter(({ choice }) => {
        const target = new URL(choice.href, url.origin)
        return url.pathname === target.pathname && [...target.searchParams].every(([key, value]) => url.searchParams.get(key) === value)
      }).sort((a, b) => new URL(b.choice.href, url.origin).searchParams.size - new URL(a.choice.href, url.origin).searchParams.size)
    return { tab, match: candidates[0] }
  })
  const setId = identities.find((item) => item.match)?.match?.set.id
  if (!setId) return tabs
  const normalized = identities.map(({ tab, match }) => ({ ...tab, destinationHref: tab.href, href: match?.set.id === setId ? match.choice.href : tab.href }))
  return applyLocalNavigationPreferences(normalized, preferences[setId]).map(({ destinationHref, ...tab }) => ({ ...tab, href: destinationHref }))
}
