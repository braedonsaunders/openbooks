import { getTranslations } from 'next-intl/server'
import { PageContainer } from '@/components/page-layout'
import { getAuthz } from '@/lib/authz'
import { loadDashboardLayout } from '../_load-layout'
import { ROLE_TIER_LABELS } from '../_role-tier'
import { DashboardGrid } from '../_dashboard-grid'
import { WIDGETS } from '../_widget-registry'
import { canSeeWidget } from '../_widget-access'
import { loadDashboardEditCanvas } from '../_edit-canvas'
import { saveQuickActions } from '../actions'
import { CustomizeDashboardHeader } from './sections'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomizeDashboard, customizeDashboardSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('dashboard')
  return { title: t('customize.title') }
}

export default async function CustomiseDashboardPage({
  searchParams,
}: {
  // Optional: this route natively takes no props. The conversion needs a query
  // flag, and threading it through must not make the prop mandatory.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  if (sp.__viewspec === '1') {
    const data = await loadCustomizeDashboard()
    if (!data) return null
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={customizeDashboardSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  const { layout, role, hiddenQuickActionIds } = await loadDashboardLayout(authz)
  const visibleLayout = {
    ...layout,
    widgets: layout.widgets.filter((w) => canSeeWidget(authz, w.id)),
  }
  const allowedWidgetIds = new Set(
    Object.keys(WIDGETS).filter((id) => canSeeWidget(authz, id)),
  )
  const { nodes, libraryCards, apps } = await loadDashboardEditCanvas(authz, visibleLayout, {
    allowedWidgetIds,
  })

  return (
    <PageContainer>
      <div className="space-y-4">
        <CustomizeDashboardHeader
          backHref="/dashboard"
          backLabel={t('customize.back')}
          title={t('customize.title')}
          roleLabel={t('customize.roleLabel', { role: ROLE_TIER_LABELS[role] })}
        />

        <DashboardGrid
          key={`${role}:${JSON.stringify(visibleLayout.widgets)}`}
          initialLayout={visibleLayout}
          nodes={nodes}
          role={role}
          mode="edit"
          libraryCards={libraryCards}
          apps={apps}
          allowedWidgetIds={allowedWidgetIds}
          quickActionsSaveAction={saveQuickActions}
          hiddenQuickActionIds={hiddenQuickActionIds}
        />
      </div>
    </PageContainer>
  )
}
