import { featureEnabled, FEATURES, type FeatureState } from '@openbooks/engine/organization/features'
import { ADMIN_HUB_PERMISSIONS, ADMIN_MODULE_KEY, NAV_MODULES } from './registry'
import { safeNavigationHref } from './preferences'

/** URL decorations never change which native module owns a destination. */
export function navPathname(href: string): string {
  if (!href.startsWith('/')) return href
  const end = href.search(/[?#]/)
  return end === -1 ? href : href.slice(0, end)
}

/** Main-menu links and local extension links must satisfy the same native gates. */
export function visibleNavigationHref(href: string, allowed: (permission: string | undefined) => boolean, state: FeatureState): boolean {
  if (!safeNavigationHref(href)) return false
  const path = navPathname(href)
  const owner = NAV_MODULES.filter((module) => {
    const root = navPathname(module.href)
    if (path !== root && !path.startsWith(`${root}/`)) return false
    if (!module.href.includes('?')) return true
    const target = new URL(module.href, 'https://navigation.invalid')
    const current = new URL(href, target.origin)
    return path === root && [...target.searchParams].every(([key, value]) => current.searchParams.get(key) === value)
  }).sort((a, b) => navPathname(b.href).length - navPathname(a.href).length || (b.href.includes('?') ? 1 : 0) - (a.href.includes('?') ? 1 : 0))[0]
  if (owner) {
    if (owner.featureKey && !featureEnabled(state, owner.featureKey)) return false
    if (FEATURES.some((feature) => feature.navModules?.includes(owner.key) && !featureEnabled(state, feature.key))) return false
    const permissions = owner.key === ADMIN_MODULE_KEY ? ADMIN_HUB_PERMISSIONS : owner.requiredPermissionsAny
    if (permissions ? !permissions.some((permission) => allowed(permission)) : !allowed(owner.requiredPermission)) return false
  }
  if ((path === '/hrm' || path.startsWith('/hrm/')) && !featureEnabled(state, 'hrm')) return false
  if ((path === '/apps' || path.startsWith('/apps/')) && (!featureEnabled(state, 'apps') || !allowed('apps.use'))) return false
  return true
}
