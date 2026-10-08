import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { reconcileNavConfig } from '@openbooks/engine/navigation'
import { listActiveExtensionContributions } from '@openbooks/engine/extensions/navigation'
import type { OrgNavConfig } from './registry'

/** One organization-scoped snapshot for menus, local navigation, and editor. */
export const readNavigationConfig = cache(async (orgId: string) => {
  const result = await db.execute<{ config: OrgNavConfig; updated_at: Date }>(sql`
    select config, updated_at from org_nav_configs where org_id = ${orgId} limit 1
  `)
  return result.rows[0] ?? null
})

/**
 * The saved layout reconciled with shipped destinations, or null when the
 * organization has not saved one. Menus and local navigation read the same
 * render-scoped value and must treat it as read-only.
 */
export const savedNavigationConfig = cache(async (orgId: string): Promise<OrgNavConfig | null> => {
  const saved = await readNavigationConfig(orgId)
  return saved?.config.version === 2 ? reconcileNavConfig(saved.config) : null
})

/** Active extension contributions, read once per render for menus, local navigation, and editor. */
export const navigationExtensionContributions = cache((orgId: string) => listActiveExtensionContributions(orgId))
