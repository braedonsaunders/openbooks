import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  type DashboardLayoutData,
} from '@openbooks/schema'
import type { Authz } from '@/lib/authz'
import { can } from '@/lib/authz'
import { INDUSTRIES } from '@/lib/industries'
import { isComplexityLevel, isTeamSize } from '@/lib/workspace-profile'
import { financialDefaultLayout, isShippedRoleLayout } from './_workspace-layout'
import { selectStoredDashboardLayout } from './_default-layout'
import { canSeeWidget, hasFinancialWorkspace } from './_widget-access'
import { isFeatureEnabled } from '@/lib/features'
import {
  CURATED_QUICK_ACTIONS,
  DEFAULT_QUICK_ACTIONS,
  hiddenCuratedQuickActionIds,
} from './_quick-actions-shared'
import {
  dashboardSourceKeyForRole,
  getUserRoleTier,
  type RoleTier,
} from './_role-tier'
import { resolvePersona } from './_persona'
import { personaDefaultLayout } from './_persona-layout'
import { widgetFeatureOn } from './widget-features'
import { qualificationSourceAvailable } from '@openbooks/engine/src/inbox/adapters/hrm-qualification-alert.ts'

type DashboardDefault = {
  layout: DashboardLayoutData
  sourceKey: string
  isSystemDefault: boolean
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
  if (isShippedRoleLayout(res.rows[0].role_key, res.rows[0].layout)) return null
  return {
    isSystemDefault: false,
    layout: res.rows[0].layout,
    sourceKey: dashboardSourceKeyForRole(res.rows[0].role_key),
  }
}

export async function resolveDashboardDefault(authz: Authz): Promise<DashboardDefault> {
  const roleDefault = await loadAssignedRoleDefault(authz)
  if (roleDefault) return roleDefault
  const role = getUserRoleTier(authz)
  if (hasFinancialWorkspace(authz)) {
    const result = await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${authz.user.orgId}`)
    const settings = result.rows[0]?.settings ?? {}
    const profile = settings.workspaceProfile as Record<string, unknown> | undefined
    const industry = INDUSTRIES.find((candidate) => candidate.key === settings.industry)
    const layout = financialDefaultLayout(role, {
      complexity: isComplexityLevel(profile?.complexity) ? profile.complexity : undefined,
      teamSize: isTeamSize(profile?.teamSize) ? profile.teamSize : undefined,
      industryCategory: industry?.category,
    })
    layout.widgets = layout.widgets.filter((widget) => canSeeWidget(authz, widget.id))
    layout.quickActions = layout.quickActions?.filter((action) => {
      const definition = CURATED_QUICK_ACTIONS.find((candidate) => candidate.id === action.id)
      return definition != null && (!definition.requiredPermission || can(authz, definition.requiredPermission))
    })
    return { layout, sourceKey: `workspace:${role}`, isSystemDefault: true }
  }
  // Personal defaults: employee always, manager by reports or
  // approval grant, admin by manage grants — what the actor holds, never
  // their role name. Gated tiles join only when their source is live; the
  // flags resolve through the single widget-feature map, so the keys live
  // in exactly one place.
  const orgId = authz.user.orgId
  const [persona, payroll, hrm, announcements, quals] = await Promise.all([
    resolvePersona(authz),
    widgetFeatureOn(orgId, 'pay-tile'),
    widgetFeatureOn(orgId, 'balance-tile'),
    widgetFeatureOn(orgId, 'announcements-card'),
    qualificationSourceAvailable(),
  ])
  const layout = personaDefaultLayout(persona, { payroll, hrm, announcements, quals })
  layout.quickActions = DEFAULT_QUICK_ACTIONS.filter((action) => {
    const definition = CURATED_QUICK_ACTIONS.find((candidate) => candidate.id === action.id)
    return definition != null && (!definition.requiredPermission || can(authz, definition.requiredPermission))
  })
  return {
    layout,
    sourceKey: `persona:${persona}`,
    isSystemDefault: true,
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
  isSystemDefault: boolean
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

  return { ...selectStoredDashboardLayout(fallback, res.rows[0]), role, hiddenQuickActionIds }
}
