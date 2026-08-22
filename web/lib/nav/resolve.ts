import 'server-only'
import { sql } from 'drizzle-orm'
import { hiddenNavModules, resolvedFeatureState } from '../features'
import { db } from '@openbooks/engine/src/db.ts'
import type { SidebarNavGroup } from '../../components/sidebar-nav'
import {
  ADMIN_HUB_PERMISSIONS,
  ADMIN_MODULE_KEY,
  MODULE_BY_KEY,
  NAV_GROUP_BY_KEY,
  NAV_GROUP_HOMES,
  NAV_MODULES,
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
export async function resolveNav(
  orgId: string,
  can: (permission: string | undefined) => boolean,
  roleKeys: readonly string[],
  t: (key: string) => string,
): Promise<SidebarNavGroup[]> {
  const [r, appResult, featureState] = await Promise.all([
    db.execute<{ config: OrgNavConfig }>(sql`select config from org_nav_configs where org_id = ${orgId} limit 1`),
    db.execute<NavAppOption>(sql`
      select a.key,
             coalesce(nullif(v.manifest #>> '{nav,label}', ''), a.name) as name,
             coalesce(nullif(v.manifest #>> '{nav,icon}', ''), a.icon_key) as "iconKey"
        from apps a
        join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
       where a.org_id = ${orgId} and a.status = 'installed'
       order by a.sort_order, a.name
    `),
    resolvedFeatureState(orgId),
  ])
  const saved = r.rows[0]?.config
  const baseConfig = saved?.version === 2 ? layerInNewModules(saved) : defaultNavConfig()
  const config = baseConfig
  const appByKey = new Map(appResult.rows.map((app) => [app.key, app]))
  const featureHiddenModules = hiddenNavModules(featureState)

  const groups: SidebarNavGroup[] = []
  for (const g of config.groups) {
    const items = []
    for (const item of g.items) {
      if (item.hidden) continue
      if (item.kind === 'module') {
        const mod = MODULE_BY_KEY.get(item.moduleKey)
        if (!mod) continue
        if (featureHiddenModules.has(mod.key)) continue
        // The collapsed Administration entry has no single permission — it
        // opens the /admin hub, which is reachable by anyone holding any
        // admin-ish permission (each card there is re-gated individually).
        if (mod.key === ADMIN_MODULE_KEY) {
          if (!ADMIN_HUB_PERMISSIONS.some((p) => can(p))) continue
        } else if (!can(mod.requiredPermission)) continue
        items.push({
          href: mod.href,
          label: item.label && item.label !== mod.label ? item.label : t(`modules.${mod.key}`) || mod.label,
          iconKey: item.iconKey ?? mod.iconKey,
          exact: mod.exact,
          mobile: item.mobile,
          // Nested sub-menu label (registry-driven; desktop sidebar renders it
          // collapsible, the top nav as a flyout, flat consumers ignore it).
          // subgroupHref makes the sub-menu header itself navigate.
          ...(mod.subgroup && g.id === mod.group
            ? {
                subgroup: t(`groups.${mod.subgroup.toLowerCase()}`) || mod.subgroup,
                ...(NAV_SUBGROUPS[mod.subgroup]
                  ? {
                      subgroupHref: NAV_SUBGROUPS[mod.subgroup].href,
                      ...(NAV_SUBGROUPS[mod.subgroup].iconKey
                        ? {
                            subgroupIconKey: NAV_SUBGROUPS[mod.subgroup].iconKey,
                          }
                        : {}),
                    }
                  : {}),
              }
            : {}),
        })
      } else if (item.kind === 'app') {
        if (!can('apps.use')) continue
        const app = appByKey.get(item.appKey)
        if (!app) continue
        items.push({
          href: `/apps/${encodeURIComponent(app.key)}`,
          label: item.label?.trim() || app.name,
          iconKey: item.iconKey ?? app.iconKey,
          mobile: item.mobile,
        })
      } else {
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
      const groupHref = NAV_GROUP_HOMES[g.id as NavGroupKey]
      groups.push({
        id: g.id,
        label: defaultGroup && g.label === defaultGroup.label ? t(`groups.${g.id}`) : g.label,
        iconKey: defaultGroup?.iconKey ?? 'grid',
        ...(groupHref ? { groupHref } : {}),
        items,
      })
    }
  }

  const recordItems = await recordTypeNavItems(orgId, can, roleKeys)
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
 * Dynamic nav entries for published custom record types flagged show_in_nav:
 * one item per generated module (/records/<key>), visible to records.read
 * holders and filtered by each type's allowed_roles audience (admins always
 * pass). Wrapped in try/catch so a database without the custom_record_types
 * table yet (pre-migration) degrades to "no Records group" instead of
 * breaking the whole shell.
 */
async function recordTypeNavItems(
  orgId: string,
  can: (permission: string | undefined) => boolean,
  roleKeys: readonly string[],
): Promise<SidebarNavGroup['items']> {
  if (!can('records.read')) return []
  try {
    const r = (await db.execute<{
        key: string
        plural_name: string
        icon_key: string
        allowed_roles: string[] | null
      }>(sql`
      select key, plural_name, icon_key, allowed_roles
        from custom_record_types
       where org_id = ${orgId} and status = 'published' and show_in_nav
       order by sort_order, plural_name
    `))
    return r.rows
      .filter(
        (t) =>
          !t.allowed_roles ||
          t.allowed_roles.length === 0 ||
          roleKeys.includes('admin') ||
          roleKeys.some((key) => t.allowed_roles!.includes(key)),
      )
      .map((t) => ({
        href: `/records/${t.key}`,
        label: t.plural_name,
        iconKey: t.icon_key,
      }))
  } catch {
    // custom_record_types not migrated yet — the shell must keep rendering.
    return []
  }
}

/** Modules shipped after the org saved its config get appended to their default group. */
function layerInNewModules(config: OrgNavConfig): OrgNavConfig {
  const present = new Set(
    config.groups.flatMap((g) => g.items.flatMap((i) => (i.kind === 'module' ? [i.moduleKey] : []))),
  )
  const missing = NAV_MODULES.filter((m) => !present.has(m.key))
  if (missing.length === 0) return config
  const groups = config.groups.map((g) => ({ ...g, items: [...g.items] }))
  for (const m of missing) {
    let g = groups.find((x) => x.id === m.group)
    if (!g) {
      const defaultGroup = NAV_GROUP_BY_KEY.get(m.group)
      if (!defaultGroup) throw new Error(`Unknown navigation group: ${m.group}`)
      g = { id: defaultGroup.key, label: defaultGroup.label, items: [] }
      groups.push(g)
    }
    g.items.push({ kind: 'module', moduleKey: m.key })
  }
  return { version: 2, groups }
}
