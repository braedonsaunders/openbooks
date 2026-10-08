import { featureEnabled, FEATURES, type FeatureState } from '@openbooks/engine/organization/features'
import { ADMIN_HUB_PERMISSIONS, ADMIN_MODULE_KEY, NAV_MODULES, type NavModule } from './registry'
import { safeNavigationHref } from './preferences'

const URL_BASE = 'https://navigation.invalid'

/** URL decorations never change which native module owns a destination. */
export function navPathname(href: string): string {
  if (!href.startsWith('/')) return href
  const end = href.search(/[?#]/)
  return end === -1 ? href : href.slice(0, end)
}

// Ownership candidates in precedence order: the longest module path wins, and
// a query-qualified destination wins over its bare path.
const NAV_OWNERS = NAV_MODULES.map((module) => ({
  module,
  root: navPathname(module.href),
  query: module.href.includes('?') ? [...new URL(module.href, URL_BASE).searchParams] : null,
})).sort((a, b) => b.root.length - a.root.length || (b.query ? 1 : 0) - (a.query ? 1 : 0))

// Features that hide a module when disabled, by module key.
const FEATURES_BY_NAV_MODULE = new Map<string, string[]>()
for (const feature of FEATURES) for (const key of feature.navModules ?? []) {
  FEATURES_BY_NAV_MODULE.set(key, [...FEATURES_BY_NAV_MODULE.get(key) ?? [], feature.key])
}

function navOwner(href: string, path: string): NavModule | undefined {
  let params: URLSearchParams | undefined
  return NAV_OWNERS.find(({ root, query }) => {
    if (path !== root && !path.startsWith(`${root}/`)) return false
    if (!query) return true
    params ??= new URL(href, URL_BASE).searchParams
    return path === root && query.every(([key, value]) => params!.get(key) === value)
  })?.module
}

/** Main-menu links and local extension links must satisfy the same native gates. */
export function visibleNavigationHref(href: string, allowed: (permission: string | undefined) => boolean, state: FeatureState): boolean {
  if (!safeNavigationHref(href)) return false
  const path = navPathname(href)
  const owner = navOwner(href, path)
  if (owner) {
    if (owner.featureKey && !featureEnabled(state, owner.featureKey)) return false
    if (owner.requiredFeatures?.some(feature => !featureEnabled(state, feature))) return false
    if (FEATURES_BY_NAV_MODULE.get(owner.key)?.some((feature) => !featureEnabled(state, feature))) return false
    const permissions = owner.key === ADMIN_MODULE_KEY ? ADMIN_HUB_PERMISSIONS : owner.requiredPermissionsAny
    if (permissions ? !permissions.some((permission) => allowed(permission)) : !allowed(owner.requiredPermission)) return false
  }
  if ((path === '/hrm' || path.startsWith('/hrm/')) && !featureEnabled(state, 'hrm')) return false
  if ((path === '/apps' || path.startsWith('/apps/')) && (!featureEnabled(state, 'apps') || !allowed('apps.use'))) return false
  return true
}
