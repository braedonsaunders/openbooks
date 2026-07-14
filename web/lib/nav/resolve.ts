import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { SidebarNavGroup } from '../../components/sidebar-nav'
import { MODULE_BY_KEY, NAV_MODULES, defaultNavConfig, type OrgNavConfig } from './registry'

/**
 * Resolve the sidebar for a user: saved org layout (or registry defaults) →
 * layer in modules shipped after the config was saved → filter by permission
 * via the caller-supplied `can` predicate → drop hidden items/empty groups.
 * (beaconhs nav/resolve.ts, org-scoped, minus form pinning for now.)
 */
export async function resolveNav(
  orgId: string,
  can: (permission: string | undefined) => boolean,
): Promise<SidebarNavGroup[]> {
  const r = (await db.execute(
    sql`select config from org_nav_configs where org_id = ${orgId} limit 1`,
  )) as unknown as { rows: { config: OrgNavConfig }[] }
  const saved = r.rows[0]?.config
  const config = saved?.version === 1 ? layerInNewModules(saved) : defaultNavConfig()

  const groups: SidebarNavGroup[] = []
  for (const g of config.groups) {
    const items = []
    for (const item of g.items) {
      if (item.hidden) continue
      if (item.kind === 'module') {
        const mod = MODULE_BY_KEY.get(item.moduleKey)
        if (!mod) continue
        if (!can(mod.requiredPermission)) continue
        items.push({
          href: mod.href,
          label: item.label ?? mod.label,
          iconKey: item.iconKey ?? mod.iconKey,
          exact: mod.exact,
        })
      } else {
        items.push({ href: item.href, label: item.label, iconKey: item.iconKey ?? 'link' })
      }
    }
    if (items.length > 0) groups.push({ label: g.label, items })
  }
  return groups
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
