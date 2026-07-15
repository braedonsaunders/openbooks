import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
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

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('dashboard')
  return { title: t('customize.title') }
}

export default async function CustomiseDashboardPage() {
  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  const { layout, role } = await loadDashboardLayout(authz)
  const visibleLayout = {
    ...layout,
    widgets: layout.widgets.filter((w) => canSeeWidget(authz, w.id)),
  }
  const allowedWidgetIds = new Set(
    Object.keys(WIDGETS).filter((id) => canSeeWidget(authz, id)),
  )
  const { nodes, libraryCards } = await loadDashboardEditCanvas(authz, visibleLayout, {
    allowedWidgetIds,
  })

  return (
    <PageContainer>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
            >
              <ArrowLeft size={12} />
              {t('customize.back')}
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
              {t('customize.title')}
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {t('customize.roleLabel', { role: ROLE_TIER_LABELS[role] })}
            </p>
          </div>
        </div>

        <DashboardGrid
          key={`${role}:${JSON.stringify(visibleLayout.widgets)}`}
          initialLayout={visibleLayout}
          nodes={nodes}
          role={role}
          mode="edit"
          libraryCards={libraryCards}
          allowedWidgetIds={allowedWidgetIds}
          quickActionsSaveAction={saveQuickActions}
        />
      </div>
    </PageContainer>
  )
}
