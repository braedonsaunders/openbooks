import 'server-only'
import { getTranslations } from 'next-intl/server'
import { LOCAL_NAVIGATION, applyLocalNavigationPreferences, type LocalNavigationPreferences } from '@openbooks/engine/navigation'
import { can, type Authz } from '../authz'
import { featureEnabled, resolvedFeatureState } from '../features'
import { defaultNavConfig, MODULE_BY_KEY } from './registry'
import { navigationExtensionContributions, savedNavigationConfig } from './config'
import { visibleNavigationHref } from './access'
import type { ViewTabGroup, ViewTabOwnership } from '../../components/module-home/view-tab-match'

// The registered workspaces and their message namespaces are static.
const WORKSPACES = LOCAL_NAVIGATION.filter((set) => !set.inline)
const NAMESPACES = [...new Set(LOCAL_NAVIGATION.flatMap((set) => set.tabs.map((tab) => tab.ns)))]

/** Resolve every native local workspace once, from the same menu snapshot. */
export async function resolveLocalNavigation(authz: Authz): Promise<{ groups: ViewTabGroup[]; ownership: ViewTabOwnership[]; preferences: LocalNavigationPreferences }> {
  const [saved, state, extensions, translators] = await Promise.all([
    savedNavigationConfig(authz.user.orgId),
    resolvedFeatureState(authz.user.orgId),
    navigationExtensionContributions(authz.user.orgId),
    Promise.all(NAMESPACES.map(async (namespace) => [namespace, await getTranslations(namespace as never)] as const)),
  ])
  const config = saved ?? defaultNavConfig()
  const menuByHref = new Map(config.groups.flatMap((group) => group.items.flatMap((item) => {
    if (item.kind !== 'module') return []
    const module = MODULE_BY_KEY.get(item.moduleKey)
    return module ? [[module.href, { item, module }] as const] : []
  })))
  // Extension destinations appear only where the saved menu placed them.
  const placedLinks = new Map(config.groups.flatMap((group) => group.items.flatMap((item) =>
    item.kind === 'link' && item.extensionKey ? [[`${item.extensionKey}\n${item.href}`, item] as const] : [],
  )).reverse())
  const translations = new Map(translators)
  const ownership: ViewTabOwnership[] = []
  const groups = WORKSPACES.filter((set) => !set.feature || featureEnabled(state, set.feature)).map((set, group) => {
    const tabs = set.tabs.filter((tab) => {
      const menu = menuByHref.get(tab.href)
      return !menu?.item.hidden && (!tab.permissionsAll || tab.permissionsAll.every(permission=>can(authz,permission))) && (tab.permissionsAny ? tab.permissionsAny.some((permission) => can(authz, permission)) : !tab.permission || can(authz, tab.permission)) && (!tab.feature || featureEnabled(state, tab.feature)) && (!tab.requiredFeatures || tab.requiredFeatures.every(feature => featureEnabled(state, feature)))
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
      const placed = placedLinks.get(`${entry.extensionKey}\n${definition.href}`)
      if (!placed || placed.hidden) return []
      return [{ href: definition.href, label: placed.label, carry: ['sub', 'book'], sharedCarry: ['sub', 'book'], navigationSet: set.id }]
    })
    ownership.push(...set.tabs.map((tab) => ({ href: tab.href, prefix: tab.prefix, group })), ...extensionTabs.map((tab) => ({ href: tab.href, group })))
    return applyLocalNavigationPreferences([...tabs, ...extensionTabs], config.localNavigation?.[set.id])
  })
  return { groups, ownership, preferences: config.localNavigation ?? {} }
}
