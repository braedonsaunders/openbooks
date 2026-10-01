import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import type { OrgNavConfig } from './registry'

/** One organization-scoped snapshot for menus, local navigation, and editor. */
export const readNavigationConfig = cache(async (orgId: string) => {
  const result = await db.execute<{ config: OrgNavConfig; updated_at: Date }>(sql`
    select config, updated_at from org_nav_configs where org_id = ${orgId} limit 1
  `)
  return result.rows[0] ?? null
})
