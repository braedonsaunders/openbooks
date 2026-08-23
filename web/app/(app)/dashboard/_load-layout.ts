import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  DEFAULT_DASHBOARD_LAYOUTS,
  type DashboardLayoutData,
} from '@openbooks/schema'
import type { Authz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import {
  CURATED_QUICK_ACTIONS,
  hiddenCuratedQuickActionIds,
} from './_quick-actions-shared'
import {
  dashboardSourceKeyForTier,
  dashboardSourceKeyForRole,
  getUserRoleTier,
  type RoleTier,
} from './_role-tier'

type DashboardDefault = {
  layout: DashboardLayoutData
  sourceKey: string
}

async function loadAssignedRoleDefault(
  authz: Authz,
): Promise<DashboardDefault | null> {
  const roleKeys = authz.user.roles.map(({ key }) => key)
  if (roleKeys.length === 0) return null
  const roleMembership = sql.join(roleKeys.map((key) => sql`${key}`), sql`, `)
  const rolePriority = sql.join(
    roleKeys.map((key, index) => sql`when role_key = ${key} then ${index}`),
    sql` `,
  )
  const res = (await db.execute(sql`
    select role_key, layout
      from role_dashboard_layouts
     where org_id = ${authz.user.orgId} and role_key in (${roleMembership})
     order by case ${rolePriority} else ${roleKeys.length} end
     limit 1
  `)) as any
  if (!res.rows[0]) return null
  return {
    layout: res.rows[0].layout as DashboardLayoutData,
    sourceKey: dashboardSourceKeyForRole(res.rows[0].role_key),
  }
}

export async function resolveDashboardDefault(
  authz: Authz,
  role: RoleTier,
): Promise<DashboardDefault> {
  const roleDefault = await loadAssignedRoleDefault(authz)
  if (roleDefault) return roleDefault
  return {
    layout: DEFAULT_DASHBOARD_LAYOUTS[role] ?? DEFAULT_DASHBOARD_LAYOUTS.viewer,
    sourceKey: dashboardSourceKeyForTier(role),
  }
}

export async function hiddenQuickActionIdsForOrg(orgId: string): Promise<string[]> {
  const keys = [...new Set(
    CURATED_QUICK_ACTIONS
      .map((action) => action.requiredFeature)
      .filter((key): key is string => key != null),
  )]
  const flags = new Map(
    await Promise.all(
      keys.map(async (key) => [key, await isFeatureEnabled(orgId, key)] as const),
    ),
  )
  return hiddenCuratedQuickActionIds((key) => flags.get(key) === true)
}

export async function loadDashboardLayout(
  authz: Authz,
): Promise<{
  layout: DashboardLayoutData
  role: RoleTier
  isCustomised: boolean
  hiddenQuickActionIds: string[]
}> {
  const role = getUserRoleTier(authz)
  const [fallback, hiddenQuickActionIds] = await Promise.all([
    resolveDashboardDefault(authz, role),
    hiddenQuickActionIdsForOrg(authz.user.orgId),
  ])

  const res = (await db.execute(sql`
    select layout, source_role, is_customised
      from user_dashboard_layouts
     where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
     limit 1
  `)) as any

  const row = res.rows[0]
  if (!row || row.source_role !== fallback.sourceKey) {
    return { layout: fallback.layout, role, isCustomised: false, hiddenQuickActionIds }
  }
  return {
    layout: row.layout as DashboardLayoutData,
    role,
    isCustomised: row.is_customised,
    hiddenQuickActionIds,
  }
}
