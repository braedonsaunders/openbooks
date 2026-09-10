import { getTranslations } from 'next-intl/server'
import { PageContainer } from '@/components/page-layout'
import { getAuthz } from '@/lib/authz'
import { ModuleView } from '@/components/viewspec/module-view'
import { loadDashboardLayout } from './_load-layout'
import { DashboardGrid } from './_dashboard-grid'
import { canSeeWidget } from './_widget-access'
import { DashboardHeader } from './_dashboard-header'
import { saveQuickActions } from './actions'
import { loadDashboardView } from './_edit-canvas'
import { buildGreeting } from './_greeting'
import { loadDashboard, dashboardSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('dashboard')
  return { title: t('title') }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadDashboard(sp)
    if (!data) return null
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={dashboardSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  const today = new Date()
  const { layout, role, hiddenQuickActionIds } = await loadDashboardLayout(authz)

  const widgets = layout.widgets.filter((w) => canSeeWidget(authz, w.id))
  const visibleLayout = { ...layout, widgets }

  const { nodes } = await loadDashboardView(authz, visibleLayout)
  const renderedLayout = {
    ...visibleLayout,
    // Removed/disabled apps and unpublished insight cards leave no live node.
    // Keep stale references out of the everyday dashboard; customization can
    // still surface and remove them on the next save.
    widgets: visibleLayout.widgets.filter((widget) => nodes[widget.id] !== undefined),
  }

  const greeting = buildGreeting(today, authz.user.name, {
    morning: t('greeting.morning'),
    afternoon: t('greeting.afternoon'),
    evening: t('greeting.evening'),
  })

  return (
    <PageContainer>
      <div className="space-y-5">
        <DashboardHeader greeting={greeting} />
        <DashboardGrid
          initialLayout={renderedLayout}
          nodes={nodes}
          role={role}
          mode="view"
          quickActionsSaveAction={saveQuickActions}
          hiddenQuickActionIds={hiddenQuickActionIds}
        />
      </div>
    </PageContainer>
  )
}

