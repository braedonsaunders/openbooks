import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { featureEnabled, hiddenNavModules, resolvedFeatureState } from '../features'
import { featureAwareNavConfig, isDefaultLocalNavigationItem } from '@openbooks/engine/navigation'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { SidebarNavGroup } from '../../components/sidebar-nav'
import { essentialsWorkspace } from '../workspace-presentation'
import { essentialsNavConfig } from './essentials'
import { navigationExtensionContributions, savedNavigationConfig } from './config'
import { visibleNavigationHref } from './access'
export { navPathname } from './access'
import {
  ADMIN_HUB_PERMISSIONS,
  ADMIN_MODULE_KEY,
  MODULE_BY_KEY,
  NAV_GROUP_BY_KEY,
  NAV_GROUP_HOMES,
  NAV_SUBGROUPS,
  defaultNavConfig,
  type NavGroupKey,
  type NavAppOption,
  type OrgNavConfig,
} from './registry'

/**
 * Resolve the sidebar for a user: saved org layout (or registry defaults) →
 * layer in modules shipped after the config was saved → filter by permission
 * via the caller-supplied `can` predicate → drop hidden items/empty groups →
 * append the dynamic "Records" group (published custom record types flagged
 * show_in_nav).
 *
 * `roleKeys` scopes role-gated record types; an unrestricted record type is
 * visible to every user who holds its required permission.
 *
 * `t` translates registry-default labels (nav.* messages). Labels an org
 * customized in /admin/navigation are user content and render verbatim; a
 * saved label that still equals the registry default is treated as default
 * (org configs snapshot English defaults at save time).
 */
/**
 * Short mobile-tab label for a module: the catalog short (nav.modulesShort)
 * when the item uses its catalog label, else the full label — tenant
 * renames keep theirs verbatim. A missing short falls back to the full
 * label, so locales and modules without one render exactly as before.
 *
 * next-intl answers a missing key with the key path itself (truthy), so a
 * bare `||` fallback would print raw paths. The optional `has` existence
 * check (threaded from the caller's translator) skips the lookup silently;
 * without it, key echoes and throws still fall back, but next-intl logs
 * the miss in development.
 */
export function resolveModuleShortLabel(
  t: (key: string) => string,
  moduleKey: string,
  fullLabel: string,
  useCatalogLabel: boolean,
  has?: (key: string) => boolean,
): string {
  if (!useCatalogLabel) return fullLabel
  const sub = `modulesShort.${moduleKey}`
  try {
    if (has && !has(sub)) return fullLabel
    const out = t(sub)
    return out === '' || out === sub || out.endsWith(`.${sub}`) ? fullLabel : out
  } catch {
    return fullLabel
  }
}

// Group header navigation: a registry group's module home is reachable with any of these.
const GROUP_HOME_PERMISSIONS: Partial<Record<NavGroupKey, readonly string[]>> = {
  customers: ['ar.read', 'crm.read', 'crm.opportunities.read', 'parties.read'],
  purchasing: ['ap.read', 'parties.read', 'expenses.read'],
  banking: ['banking.read'], accounting: ['gl.read', 'close.read', 'reports.read'],
  insights: ['reports.read'], hrm: ['hrm.employment.read'], settings: [...ADMIN_HUB_PERMISSIONS],
}

/** Installed apps offered as menu destinations; read once per render. */
const installedNavigationApps = cache(async (orgId: string) => (await db.execute<NavAppOption>(sql`
  select a.key,
         coalesce(nullif(v.manifest #>> '{nav,label}', ''), a.name) as name,
         coalesce(nullif(v.manifest #>> '{nav,icon}', ''), a.icon_key) as "iconKey"
    from apps a
    join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
   where a.org_id = ${orgId} and a.status = 'installed'
   order by a.sort_order, a.name
`)).rows)

/** The layout an organization starts from when it has not saved one. */
async function navigationConfig(orgId: string): Promise<OrgNavConfig> {
  return await savedNavigationConfig(orgId)
    ?? (await essentialsWorkspace(orgId) ? essentialsNavConfig() : defaultNavConfig())
}

export async function resolveNav(
  orgId: string,
  can: (permission: string | undefined) => boolean,
  roleKeys: readonly string[],
  t: (key: string) => string,
  has?: (key: string) => boolean,
): Promise<SidebarNavGroup[]> {
  // Every source is independent; the layout and module homes share each read
  // within a render.
  const [baseConfig, apps, featureState, extensionContributions, recordTypes] = await Promise.all([
    navigationConfig(orgId),
    installedNavigationApps(orgId),
    resolvedFeatureState(orgId),
    navigationExtensionContributions(orgId),
    can('records.read') ? navigationRecordTypes(orgId) : [],
  ])
  const config = featureAwareNavConfig(baseConfig, featureEnabled(featureState, 'hrm'))
  const appByKey = new Map(apps.map((app) => [app.key, app]))
  const featureHiddenModules = hiddenNavModules(featureState)

  const groups: SidebarNavGroup[] = []
  for (const g of config.groups) {
    const items = []
    for (const item of g.items) {
      if (item.hidden) continue
      if (item.kind === 'module') {
        const mod = MODULE_BY_KEY.get(item.moduleKey)
        if (!mod) continue
        const parent = mod.menuParent ? MODULE_BY_KEY.get(mod.menuParent) : undefined
        if (isDefaultLocalNavigationItem(g.id, item) && parent && visibleNavigationHref(parent.href, can, featureState)) continue
        if (mod.homeOnly && g.id === mod.group && item.placement !== 'custom') continue
        if (featureHiddenModules.has(mod.key)) continue
        if (mod.featureKey && !featureEnabled(featureState, mod.featureKey)) continue
        if (mod.requiredFeatures?.some(feature => !featureEnabled(featureState, feature))) continue
        // The collapsed Administration entry has no single permission — it
        // opens the /admin hub, which is reachable by anyone holding any
        // admin-ish permission (each card there is re-gated individually).
        if (mod.key === ADMIN_MODULE_KEY) {
          if (!ADMIN_HUB_PERMISSIONS.some((p) => can(p))) continue
        } else if (mod.requiredPermissionsAny ? !mod.requiredPermissionsAny.some((permission) => can(permission)) : !can(mod.requiredPermission)) continue
        // A saved label that still equals the registry default counts as the
        // catalog label (org configs snapshot English defaults at save time).
        const useCatalogLabel = !(item.label && item.label !== mod.label)
        const translated = has && !has(`modules.${mod.key}`) ? '' : t(`modules.${mod.key}`)
        const fullLabel = item.label && item.label !== mod.label ? item.label : translated && translated !== `modules.${mod.key}` && translated !== `nav.modules.${mod.key}` ? translated : mod.label
        items.push({
          href: mod.href,
          label: fullLabel,
          shortLabel: resolveModuleShortLabel(t, mod.key, fullLabel, useCatalogLabel, has),
          iconKey: item.iconKey ?? mod.iconKey,
          exact: mod.exact,
          mobile: item.mobile,
          // HR-15: inbox badge plumbing — the count route self-scopes to the actor.
          ...(mod.badgeCountHref ? { badgeCountHref: mod.badgeCountHref } : {}),
          // Nested sub-menu label (registry-driven; desktop sidebar renders it
          // collapsible, the top nav as a flyout, flat consumers ignore it).
          // subgroupHref makes the sub-menu header itself navigate.
          ...(mod.subgroup && (g.id === mod.group || (mod.group === 'hrm' && g.id === 'operations' && !featureEnabled(featureState, 'hrm')))
            ? {
                subgroup: t(`groups.${mod.subgroup.toLowerCase()}`) || mod.subgroup,
                ...(NAV_SUBGROUPS[mod.subgroup]
                  ? {
                      subgroupHref: NAV_SUBGROUPS[mod.subgroup]!.href,
                      ...(NAV_SUBGROUPS[mod.subgroup]!.iconKey
                        ? {
                            subgroupIconKey: NAV_SUBGROUPS[mod.subgroup]!.iconKey,
                          }
                        : {}),
                    }
                  : {}),
              }
            : {}),
        })
      } else if (item.kind === 'app') {
        if (!can('apps.use') || !featureEnabled(featureState, 'apps')) continue
        const app = appByKey.get(item.appKey)
        if (!app) continue
        items.push({
          href: `/apps/${encodeURIComponent(app.key)}`,
          label: item.label?.trim() || app.name,
          iconKey: item.iconKey ?? app.iconKey,
          mobile: item.mobile,
        })
      } else {
        if (!visibleNavigationHref(item.href, can, featureState)) continue
        if (item.extensionKey) {
          const entry = extensionContributions.find((entry) => entry.extensionKey === item.extensionKey && entry.contribution.kind === 'nav' && entry.contribution.href === item.href)
          if (!entry || entry.contribution.kind !== 'nav' || !can(entry.contribution.requiredPermission)) continue
        } else if (!can(item.requiredPermission)) continue
        items.push({
          href: item.href,
          label: item.label,
          iconKey: item.iconKey ?? 'link',
          mobile: item.mobile,
        })
      }
    }
    if (items.length > 0) {
      const defaultGroup = NAV_GROUP_BY_KEY.get(g.id as NavGroupKey)
      // Group header navigation: registry groups with a module home get a
      // groupHref (custom org groups never match and stay plain toggles).
      const home = NAV_GROUP_HOMES[g.id as NavGroupKey]
      const homePermissions = GROUP_HOME_PERMISSIONS[g.id as NavGroupKey]
      const groupHref = home && (!homePermissions || homePermissions.some((permission) => can(permission))) && (g.id !== 'hrm' || featureEnabled(featureState, 'hrm')) ? home : undefined
      groups.push({
        id: g.id,
        label: defaultGroup && g.label === defaultGroup.label ? t(`groups.${g.id}`) : g.label,
        iconKey: defaultGroup?.iconKey ?? 'grid',
        ...(groupHref ? { groupHref } : {}),
        items,
      })
    }
  }

  // A record type restricted to roles is visible to its audience; admins always pass.
  const recordItems = recordTypes
    .filter((type) => !type.allowed_roles || type.allowed_roles.length === 0 || roleKeys.includes('admin') || roleKeys.some((key) => type.allowed_roles!.includes(key)))
    .map((type) => ({ href: `/records/${type.key}`, label: type.plural_name, iconKey: type.icon_key }))
  if (recordItems.length > 0) {
    groups.push({
      id: 'records',
      label: t('groups.records'),
      iconKey: 'grid',
      items: recordItems,
    })
  }

  return groups
}

/**
 * Published custom record types flagged show_in_nav: one destination per
 * generated module (/records/<key>), visible to records.read holders. A
 * database without the custom_record_types table yet (pre-migration)
 * degrades to "no Records group" instead of breaking the whole shell.
 */
const navigationRecordTypes = cache(async (orgId: string) => {
  try {
    return (await db.execute<{
      key: string
      plural_name: string
      icon_key: string
      allowed_roles: string[] | null
    }>(sql`
      select key, plural_name, icon_key, allowed_roles
        from custom_record_types
       where org_id = ${orgId} and status = 'published' and show_in_nav
       order by sort_order, plural_name
    `)).rows
  } catch {
    // custom_record_types not migrated yet — the shell must keep rendering.
    return []
  }
})
