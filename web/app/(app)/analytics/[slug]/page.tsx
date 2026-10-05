import { getTranslations } from 'next-intl/server'
import { notFound, redirect } from 'next/navigation'
import { ModuleView } from '@/components/viewspec/module-view'
import { requirePermission } from '@/lib/authz'
import { ANALYTICS_DASHBOARD_MAP } from '@/lib/analytics/dashboard-catalog'
import { analyticsDashboardAvailable } from '@/lib/analytics/dashboard-access'
import { builtInReportDefinitionId } from '@/lib/custom-reports'
import { loadReportRun, reportRunSpec } from '../../reports/custom/run/[id]/view'

export const dynamic = 'force-dynamic'

/** Analytical tables keep the native report paper, filters, exports and saved views. */
export default async function AnalyticsReportPage({ params, searchParams }: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { slug } = await params
  const authz = await requirePermission('reports.read')
  const dashboard = ANALYTICS_DASHBOARD_MAP[slug]
  if (!dashboard || !(await analyticsDashboardAvailable(authz, dashboard))) notFound()
  if (dashboard.reportHref) {
    const query = new URLSearchParams(Object.entries(await searchParams).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    redirect(`${dashboard.reportHref}${query.size ? `?${query}` : ''}`)
  }
  if (!dashboard.reportSlug) notFound()
  const id = await builtInReportDefinitionId(authz.user.orgId, dashboard.reportSlug)
  if (!id) notFound()
  const sp = await searchParams
  const data = await loadReportRun(id, sp)
  data.backHref = '/analytics'
  data.backLabel = (await getTranslations('analytics.hub'))('title')
  return <ModuleView spec={reportRunSpec(data)} data={data} searchParams={sp} trusted />
}
