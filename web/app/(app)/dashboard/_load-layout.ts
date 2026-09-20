import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  type DashboardLayoutData,
} from '@openbooks/schema'
import type { Authz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import {
  CURATED_QUICK_ACTIONS,
  hiddenCuratedQuickActionIds,
} from './_quick-actions-shared'
import {
  dashboardSourceKeyForRole,
  getUserRoleTier,
  type RoleTier,
} from './_role-tier'
import { resolvePersona } from './_persona'
import { personaDefaultLayout } from './_persona-layout'
import { qualificationSourceAvailable } from '@openbooks/engine/src/inbox/adapters/hrm-qualification-alert.ts'
import { DashboardLayoutInputSchema, clampToWidgetMinimums } from './_layout-input'

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
  const res = await db.execute<{ role_key: string; layout: DashboardLayoutData }>(sql`
    select role_key, layout
      from role_dashboard_layouts
     where org_id = ${authz.user.orgId} and role_key in (${roleMembership})
     order by case ${rolePriority} else ${roleKeys.length} end
     limit 1
  `)
  if (!res.rows[0]) return null
  return {
    layout: res.rows[0].layout,
    sourceKey: dashboardSourceKeyForRole(res.rows[0].role_key),
  }
}

export async function resolveDashboardDefault(authz: Authz): Promise<DashboardDefault> {
  const roleDefault = await loadAssignedRoleDefault(authz)
  if (roleDefault) return roleDefault
  // HR-15 persona defaults: employee always, manager by reports or
  // approval grant, admin by manage grants — what the actor holds, never
  // their role name. Gated tiles join only when their source is live.
  const orgId = authz.user.orgId
  const [persona, payroll, hrm, celebrations, nudges, announcements, quals] = await Promise.all([
    resolvePersona(authz),
    isFeatureEnabled(orgId, 'payroll'),
    isFeatureEnabled(orgId, 'hrm'),
    isFeatureEnabled(orgId, 'hrmCelebrations'),
    isFeatureEnabled(orgId, 'hrmManagerNudges'),
    isFeatureEnabled(orgId, 'homeAnnouncements'),
    qualificationSourceAvailable(),
  ])
  return {
    layout: personaDefaultLayout(persona, { payroll, hrm, celebrations, nudges, announcements, quals }),
    sourceKey: `persona:${persona}`,
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
    resolveDashboardDefault(authz),
    hiddenQuickActionIdsForOrg(authz.user.orgId),
  ])

  const res = await db.execute<{ layout: unknown; source_role: string | null; is_customised: boolean }>(sql`
    select layout, source_role, is_customised
      from user_dashboard_layouts
     where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
     limit 1
  `)

  const row = res.rows[0]
  // A customized layout is the tenant's own: it survives default changes
  // (HR-15 persona defaults included). Only an uncustomized row whose
  // source no longer matches falls forward to the fresh default.
  if (!row || (row.source_role !== fallback.sourceKey && !row.is_customised)) {
    return { layout: fallback.layout, role, isCustomised: false, hiddenQuickActionIds }
  }
  // Fail-safe read: a stored layout the registry cannot honor — malformed, or
  // an empty grid left by the pre-fix quick-actions save — falls back to the
  // default, never a blank dashboard or a render crash. No write-back: the
  // tenant's next save overwrites the bad row, which is the self-heal.
  const parsed = DashboardLayoutInputSchema.safeParse(row.layout)
  if (!parsed.success || parsed.data.widgets.length === 0) {
    return { layout: fallback.layout, role, isCustomised: false, hiddenQuickActionIds }
  }
  const storedQuickActions =
    typeof row.layout === 'object' && row.layout !== null && 'quickActions' in row.layout
      ? row.layout.quickActions
      : undefined
  return {
    layout: {
      widgets: clampToWidgetMinimums(parsed.data.widgets),
      ...(Array.isArray(storedQuickActions) ? { quickActions: storedQuickActions } : {}),
    },
    role,
    isCustomised: row.is_customised,
    hiddenQuickActionIds,
  }
}
