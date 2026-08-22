import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { trueCostData } from '../../../../lib/analytics/true-cost-data'
import { ReportFilterBar } from '../../reports/ReportFilterBar'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { TrueCostView } from './TrueCostView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.trueCost')
  return { title: t('title') }
}

export default async function TrueCostPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('analytics.trueCost')
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'projects')

  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await trueCostData(authz.user.orgId, { from: period.from, to: period.to, label: period.label })

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={period.label} backLabel={t('backToHub')}>
          <ReportFilterBar controls={{ period: true }} />
        </AnalyticsHeader>
      }
    >
      <TrueCostView data={data} />
    </ListPageLayout>
  )
}
