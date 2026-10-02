import 'server-only'
import { getTranslations } from 'next-intl/server'
import { LOCAL_NAVIGATION, applyLocalNavigationPreferences } from '@openbooks/engine/navigation'
import { reconcileNavConfig } from '@openbooks/engine/navigation'
import { can, type Authz } from '../authz'
import { featureEnabled, resolvedFeatureState } from '../features'
import { defaultNavConfig, MODULE_BY_KEY } from './registry'
import { readNavigationConfig } from './config'
import { visibleNavigationHref } from './access'
import type { ViewTabGroup, ViewTabOwnership } from '../../components/module-home/view-tab-match'
import { listActiveExtensionContributions } from '@openbooks/engine/extensions/navigation'

/** Resolve every native local workspace once, from the same menu snapshot. */
export async function resolveLocalNavigation(authz: Authz): Promise<{ groups: ViewTabGroup[]; ownership: ViewTabOwnership[]; preferences: import('@openbooks/engine/navigation').LocalNavigationPreferences }> {
  const [saved, state, extensions] = await Promise.all([readNavigationConfig(authz.user.orgId), resolvedFeatureState(authz.user.orgId), listActiveExtensionContributions(authz.user.orgId)])
  const config = saved?.config.version === 2 ? reconcileNavConfig(saved.config) : defaultNavConfig()
  const menuByHref = new Map(config.groups.flatMap((group) => group.items.flatMap((item) => {
    if (item.kind !== 'module') return []
    const module = MODULE_BY_KEY.get(item.moduleKey)
    return module ? [[module.href, { item, module }] as const] : []
  })))
  const namespaces = [...new Set(LOCAL_NAVIGATION.flatMap((set) => set.tabs.map((tab) => tab.ns)))]
  const translations = new Map(await Promise.all(namespaces.map(async (namespace) => [namespace, await getTranslations(namespace as never)] as const)))
  const ownership: ViewTabOwnership[] = []
  const groups = LOCAL_NAVIGATION.filter((set) => !set.inline).filter((set) => !set.feature || featureEnabled(state, set.feature)).map((set, group) => {
    const tabs = set.tabs.filter((tab) => {
      const menu = menuByHref.get(tab.href)
      return !menu?.item.hidden && (tab.permissionsAny ? tab.permissionsAny.some((permission) => can(authz, permission)) : !tab.permission || can(authz, tab.permission)) && (!tab.feature || featureEnabled(state, tab.feature)) && (!tab.requiredFeatures || tab.requiredFeatures.every(feature => featureEnabled(state, feature)))
    }).map((tab) => {
      const t = translations.get(tab.ns)!
      const menu = menuByHref.get(tab.href)
      const renamed = menu?.item.label && menu.item.label !== menu.module.label ? menu.item.label : undefined
      return {
        href: tab.href, label: renamed ?? t(tab.key as never),
        secondary: tab.secondary,
        ...(tab.prefix ? { prefix: true } : {}),
        // The legal-entity and accounting-book lenses are shared between
        // sibling routes. Task-specific filters travel only on the same route.
        carry: [...new Set(['sub', 'book', ...(tab.carry ?? [])])],
        sharedCarry: ['sub', 'book'],
        navigationSet: set.id,
      }
    })
    const extensionTabs = extensions.flatMap((entry) => {
      const definition = entry.contribution
      if (definition.kind !== 'nav' || definition.workspaceKey !== set.id || (definition.requiredPermission && !can(authz, definition.requiredPermission))) return []
      if (!visibleNavigationHref(definition.href, (permission) => !permission || can(authz, permission), state)) return []
      const placed = config.groups.flatMap((group) => group.items).find((item) => item.kind === 'link' && item.extensionKey === entry.extensionKey && item.href === definition.href)
      if (!placed || placed.hidden || placed.kind !== 'link') return []
      return [{ href: definition.href, label: placed.label, carry: ['sub', 'book'], sharedCarry: ['sub', 'book'], navigationSet: set.id }]
    })
    ownership.push(...set.tabs.map((tab) => ({ href: tab.href, prefix: tab.prefix, group })), ...extensionTabs.map((tab) => ({ href: tab.href, group })))
    return applyLocalNavigationPreferences([...tabs, ...extensionTabs], config.localNavigation?.[set.id])
  })
  return { groups, ownership, preferences: config.localNavigation ?? {} }
}
