import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { SidebarNavGroup } from '../../components/sidebar-nav'
import {
  ADMIN_HUB_PERMISSIONS,
  ADMIN_MODULE_KEY,
  MODULE_BY_KEY,
  NAV_MODULES,
  defaultNavConfig,
  type OrgNavConfig,
} from './registry'

/**
 * Resolve the sidebar for a user: saved org layout (or registry defaults) →
 * layer in modules shipped after the config was saved → filter by permission
 * via the caller-supplied `can` predicate → drop hidden items/empty groups →
 * append the dynamic "Records" group (published custom record types flagged
 * show_in_nav). (beaconhs nav/resolve.ts, org-scoped, minus form pinning for
 * now.)
 *
 * `role` (the user's role key, e.g. authz.user.role) scopes role-gated record
 * types; when omitted, only types without an allowed_roles restriction appear.
 *
 * `t` translates registry-default labels (nav.* messages). Labels an org
 * customized in /admin/navigation are user content and render verbatim; a
 * saved label that still equals the registry default is treated as default
 * (org configs snapshot English defaults at save time).
 */
export async function resolveNav(
  orgId: string,
  can: (permission: string | undefined) => boolean,
  role: string | null | undefined,
  t: (key: string) => string,
): Promise<SidebarNavGroup[]> {
  const r = (await db.execute(
    sql`select config from org_nav_configs where org_id = ${orgId} limit 1`,
  )) as unknown as { rows: { config: OrgNavConfig }[] }
  const saved = r.rows[0]?.config
  const config = saved?.version === 1 ? layerInNewModules(saved) : defaultNavConfig()

  // Registry-default group names → nav.groups.* message keys. A saved config
  // whose group label matches a default gets translated; anything else is an
  // org's own wording.
  const DEFAULT_GROUP_SLUGS = new Map(
    [...new Set(NAV_MODULES.map((m) => m.group))].map((label) => [
      label,
      label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ]),
  )

  const groups: SidebarNavGroup[] = []
  for (const g of config.groups) {
    const items = []
    for (const item of g.items) {
      if (item.hidden) continue
      if (item.kind === 'module') {
        const mod = MODULE_BY_KEY.get(item.moduleKey)
        if (!mod) continue
        // The collapsed Administration entry has no single permission — it
        // opens the /admin hub, which is reachable by anyone holding any
        // admin-ish permission (each card there is re-gated individually).
        if (mod.key === ADMIN_MODULE_KEY) {
          if (!ADMIN_HUB_PERMISSIONS.some((p) => can(p))) continue
        } else if (!can(mod.requiredPermission)) continue
        items.push({
          href: mod.href,
          label:
            item.label && item.label !== mod.label
              ? item.label
              : t(`modules.${mod.key}`) || mod.label,
          iconKey: item.iconKey ?? mod.iconKey,
          exact: mod.exact,
        })
      } else {
        items.push({ href: item.href, label: item.label, iconKey: item.iconKey ?? 'link' })
      }
    }
    if (items.length > 0) {
      const slug = DEFAULT_GROUP_SLUGS.get(g.label)
      groups.push({ label: slug ? t(`groups.${slug}`) : g.label, items })
    }
  }

  const recordItems = await recordTypeNavItems(orgId, can, role ?? null)
  if (recordItems.length > 0) groups.push({ label: t('groups.records'), items: recordItems })

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
  role: string | null,
): Promise<SidebarNavGroup['items']> {
  if (!can('records.read')) return []
  try {
    const r = (await db.execute(sql`
      select key, plural_name, icon_key, allowed_roles
        from custom_record_types
       where org_id = ${orgId} and status = 'published' and show_in_nav
       order by sort_order, plural_name
    `)) as unknown as {
      rows: { key: string; plural_name: string; icon_key: string; allowed_roles: string[] | null }[]
    }
    return r.rows
      .filter(
        (t) =>
          !t.allowed_roles ||
          t.allowed_roles.length === 0 ||
          role === 'admin' ||
          (role !== null && t.allowed_roles.includes(role)),
      )
      .map((t) => ({ href: `/records/${t.key}`, label: t.plural_name, iconKey: t.icon_key }))
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
    let g = groups.find((x) => x.label === m.group)
    if (!g) {
      g = { id: m.group.toLowerCase().replace(/\s+/g, '-'), label: m.group, items: [] }
      groups.push(g)
    }
    g.items.push({ kind: 'module', moduleKey: m.key })
  }
  return { version: 1, groups }
}
