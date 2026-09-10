import { getTranslations } from 'next-intl/server'
import { PageContainer } from '@/components/page-layout'
import { getAuthz } from '@/lib/authz'
import { ModuleView } from '@/components/viewspec/module-view'
import { loadDashboardLayout } from './dashboard/_load-layout'
import { DashboardGrid } from './dashboard/_dashboard-grid'
import { canSeeWidget } from './dashboard/_widget-access'
import { DashboardHeader } from './dashboard/_dashboard-header'
import { saveQuickActions } from './dashboard/actions'
import { loadDashboardView } from './dashboard/_edit-canvas'
import { loadRootDashboard, rootDashboardSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadRootDashboard(sp)
    if (!data) return null
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={rootDashboardSpec(data)} data={data} searchParams={sp} trusted />
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
          initialLayout={visibleLayout}
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

function buildGreeting(
  now: Date,
  name: string | null,
  copy: { morning: string; afternoon: string; evening: string },
): string {
  const hour = now.getHours()
  const stem = hour < 12 ? copy.morning : hour < 17 ? copy.afternoon : copy.evening
  const firstName = name?.trim().split(/\s+/)[0] ?? null
  return firstName ? `${stem}, ${firstName}` : stem
}
