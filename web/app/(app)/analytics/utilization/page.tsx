import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { utilizationData } from '../../../../lib/analytics/utilization-data'
import { ReportFilterBar } from '../../reports/ReportFilterBar'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { UtilizationView } from './UtilizationView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.utilization')
  return { title: t('title') }
}

export default async function UtilizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('analytics.utilization')
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'timeTracking')

  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await utilizationData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz.allowedSubsidiaryIds)

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={period.label} backLabel={t('backToHub')}>
          <ReportFilterBar controls={{ period: true }} />
        </AnalyticsHeader>
      }
    >
      <UtilizationView data={data} />
    </ListPageLayout>
  )
}
