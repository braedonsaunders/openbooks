'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, getAuthz } from '@/lib/authz'
import { NAV_MODULES } from '@/lib/nav/registry'
import { getUserRoleTier, dashboardSourceKeyForTier, dashboardSourceKeyForRole } from './_role-tier'
import { hiddenQuickActionIdsForOrg, resolveDashboardDefault } from './_load-layout'
import { canSeeWidget, canSeeInsightCards } from './_widget-access'
import { WIDGETS } from './_widget-registry'
import { featureEnabled, hiddenNavModules, resolvedFeatureState } from '@/lib/features'
import {
  CURATED_QUICK_ACTIONS,
  normalizeQuickActions,
  type QuickActionOption,
} from './_quick-actions-shared'
import { QuickActionsSchema } from './_quick-actions-input'
import { DashboardLayoutInputSchema, filterPersistableDashboardWidgets } from './_layout-input'
import type { DashboardLayoutData } from '@openbooks/schema'
import { listApps } from '@/lib/apps/store'
import { appWidgetId } from '@/lib/apps/surfaces'

export async function saveDashboardLayout(input: unknown) {
  const authz = await getAuthz()
  if (!authz) return { ok: false as const, error: 'Not signed in' }

  const parsed = DashboardLayoutInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false as const, error: parsed.error.message }

  const allowedWidgetIds = new Set(
    Object.keys(WIDGETS).filter((id) => canSeeWidget(authz, id)),
  )
  const allowedAppWidgetIds = can(authz, 'apps.use')
    ? new Set(
        (await listApps(authz.user.orgId))
          .filter((app) => app.status === 'installed' && app.activeVersionId)
          .map((app) => appWidgetId(app.key)),
      )
    : new Set<string>()
  const widgets = filterPersistableDashboardWidgets(parsed.data.widgets, {
    allowedWidgetIds,
    allowedAppWidgetIds,
    // Must match canSeeWidget's insight-card visibility (insights.read OR
    // reports.read), or saving would silently drop cards the user can see.
    allowAnyInsightCardUuid: canSeeInsightCards(authz),
  })

  const role = getUserRoleTier(authz)
  const dashboardDefault = await resolveDashboardDefault(authz, role)
  const sourceRole = dashboardDefault.sourceKey

  const layout: DashboardLayoutData = { widgets }

  // The read-merge-write must run on ONE connection inside a transaction:
  // pg_advisory_xact_lock on a pooled db.execute would lock a connection the
  // following statements don't necessarily reuse, and release immediately.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`dashboard:${authz.user.orgId}:${authz.user.id}`}, 0))
    `)

    const existing = ((await tx.execute(sql`
      select layout from user_dashboard_layouts
       where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
       limit 1
    `)))
    const existingLayout = existing.rows[0]?.layout as DashboardLayoutData | undefined
    if (existingLayout?.quickActions) layout.quickActions = normalizeQuickActions(existingLayout.quickActions)

    await tx.execute(sql`
      insert into user_dashboard_layouts (id, org_id, user_id, layout, source_role, is_customised, created_at, updated_at)
      values (uuid_generate_v7(), ${authz.user.orgId}, ${authz.user.id}, ${JSON.stringify(layout)}::jsonb, ${sourceRole}, true, now(), now())
      on conflict (org_id, user_id)
      do update set layout = ${JSON.stringify(layout)}::jsonb, source_role = ${sourceRole}, is_customised = true, updated_at = now()
      where user_dashboard_layouts.org_id = ${authz.user.orgId}
    `)
  })

  revalidatePath('/')
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/customize')
  return { ok: true as const }
}

export async function resetDashboardLayout() {
  const authz = await getAuthz()
  if (!authz) return { ok: false as const, error: 'Not signed in' }

  await db.execute(sql`
    delete from user_dashboard_layouts
     where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
  `)

  revalidatePath('/')
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/customize')
  return { ok: true as const }
}

export async function saveQuickActions(input: unknown) {
  const authz = await getAuthz()
  if (!authz) return { ok: false as const, error: 'Not signed in' }

  const parsed = QuickActionsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'Invalid quick actions' }
  }

  const role = getUserRoleTier(authz)
  const dashboardDefault = await resolveDashboardDefault(authz, role)
  const sourceRole = dashboardDefault.sourceKey
  const hiddenIds = new Set(await hiddenQuickActionIdsForOrg(authz.user.orgId))
  const normalized = normalizeQuickActions(parsed.data)
  const incoming = normalized.filter((action) => !hiddenIds.has(action.id))

  // Same single-connection transactional lock as saveDashboardLayout — the
  // advisory lock is only meaningful for the statements sharing its txn.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`dashboard:${authz.user.orgId}:${authz.user.id}`}, 0))
    `)

    const existing = ((await tx.execute(sql`
      select layout from user_dashboard_layouts
       where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
       limit 1
    `)))
    const existingLayout = (existing.rows[0]?.layout ?? { widgets: [] }) as DashboardLayoutData
    const preserved = normalizeQuickActions(existingLayout.quickActions ?? [])
      .filter((action) => hiddenIds.has(action.id))
    const incomingIds = new Set(incoming.map((action) => action.id))
    const quickActions = [
      ...incoming,
      ...preserved.filter((action) => !incomingIds.has(action.id)),
    ]
    const layout: DashboardLayoutData = {
      widgets: existingLayout.widgets ?? [],
      quickActions,
    }

    await tx.execute(sql`
      insert into user_dashboard_layouts (id, org_id, user_id, layout, source_role, is_customised, created_at, updated_at)
      values (uuid_generate_v7(), ${authz.user.orgId}, ${authz.user.id}, ${JSON.stringify(layout)}::jsonb, ${sourceRole}, true, now(), now())
      on conflict (org_id, user_id)
      do update set layout = ${JSON.stringify(layout)}::jsonb, source_role = ${sourceRole}, is_customised = true, updated_at = now()
      where user_dashboard_layouts.org_id = ${authz.user.orgId}
    `)
  })

  revalidatePath('/')
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/customize')
  return { ok: true as const }
}

export async function listQuickActionOptions(): Promise<{
  common: QuickActionOption[]
}> {
  const authz = await getAuthz()
  if (!authz) return { common: [] }

  const common: QuickActionOption[] = []
  const t = await getTranslations('dashboard')

  // One authoritative feature snapshot drives both curated create chips and
  // navigate options. hiddenNavModules is the SAME mapping the sidebar
  // resolver applies (web/lib/nav/resolve.ts), so the picker can never offer
  // a navigate target whose page 404s with the feature off — including every
  // module a future FEATURES entry adds to navModules.
  const featureState = await resolvedFeatureState(authz.user.orgId)
  const hiddenModules = hiddenNavModules(featureState)

  for (const action of CURATED_QUICK_ACTIONS) {
    if (action.requiredPermission && !can(authz, action.requiredPermission)) continue
    if (action.requiredFeature && !featureEnabled(featureState, action.requiredFeature)) continue
    common.push({
      id: action.id,
      label: t(`quickActions.labels.${action.labelKey}`),
      labelKey: action.labelKey,
      href: action.href,
      iconKey: action.iconKey,
      tone: action.tone,
      hint: action.hint,
    })
  }

  for (const mod of NAV_MODULES) {
    if (mod.key === 'dashboard' || mod.key === 'admin') continue
    if (mod.requiredPermission && !can(authz, mod.requiredPermission)) continue
    if (hiddenModules.has(mod.key)) continue
    common.push({
      label: mod.label,
      href: mod.href,
      iconKey: mod.iconKey,
      tone: 'slate',
      hint: 'Navigate',
    })
  }

  if (can(authz, 'apps.use')) {
    const apps = await listApps(authz.user.orgId)
    for (const app of apps) {
      if (app.status !== 'installed' || !app.activeVersionId) continue
      common.push({
        label: app.name,
        href: `/apps/${encodeURIComponent(app.key)}`,
        iconKey: app.iconKey,
        tone: 'teal',
        hint: 'App',
      })
    }
  }

  return { common }
}
