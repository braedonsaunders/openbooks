import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  DEFAULT_DASHBOARD_LAYOUTS,
  type DashboardLayoutData,
} from '@openbooks/schema'
import type { Authz } from '@/lib/authz'
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
  role: RoleTier,
): Promise<DashboardDefault | null> {
  const res = (await db.execute(sql`
    select layout
      from role_dashboard_layouts
     where org_id = ${authz.user.orgId} and role_key = ${authz.user.role}
     limit 1
  `)) as any
  if (!res.rows[0]) return null
  return {
    layout: res.rows[0].layout as DashboardLayoutData,
    sourceKey: dashboardSourceKeyForRole(authz.user.role),
  }
}

export async function resolveDashboardDefault(
  authz: Authz,
  role: RoleTier,
): Promise<DashboardDefault> {
  const roleDefault = await loadAssignedRoleDefault(authz, role)
  if (roleDefault) return roleDefault
  return {
    layout: DEFAULT_DASHBOARD_LAYOUTS[role] ?? DEFAULT_DASHBOARD_LAYOUTS.viewer,
    sourceKey: dashboardSourceKeyForTier(role),
  }
}

export async function loadDashboardLayout(
  authz: Authz,
): Promise<{ layout: DashboardLayoutData; role: RoleTier; isCustomised: boolean }> {
  const role = getUserRoleTier(authz)
  const fallback = await resolveDashboardDefault(authz, role)

  const res = (await db.execute(sql`
    select layout, source_role, is_customised
      from user_dashboard_layouts
     where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
     limit 1
  `)) as any

  const row = res.rows[0]
  if (!row || row.source_role !== fallback.sourceKey) {
    return { layout: fallback.layout, role, isCustomised: false }
  }
  return {
    layout: row.layout as DashboardLayoutData,
    role,
    isCustomised: row.is_customised,
  }
}
