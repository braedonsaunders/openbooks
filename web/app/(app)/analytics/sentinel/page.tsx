import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadSentinel, sentinelSpec } from './view'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { ListPageLayout } from '../../../../components/page-layout'
import { can, requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { sentinelData } from '../../../../lib/analytics/sentinel-data'
import { ReportFilterBar } from '../../reports/ReportFilterBar'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { SentinelView } from './SentinelView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.sentinel')
  return { title: t('title') }
}

export default async function SentinelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadSentinel(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={sentinelSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const t = await getTranslations('analytics.sentinel')
  const authz = await requirePermission('reports.read')
  if (authz.allowedSubsidiaryIds !== null || !can(authz, 'admin.audit.read')) redirect('/')

  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await sentinelData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz)

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={period.label} backLabel={t('backToHub')}>
          <ReportFilterBar controls={{ period: true }} />
        </AnalyticsHeader>
      }
    >
      <SentinelView data={data} />
    </ListPageLayout>
  )
}
