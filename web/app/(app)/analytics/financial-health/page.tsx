import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { RATIO_DEFS } from '../../../../lib/analytics/financial-health'
import { healthData } from '../../../../lib/analytics/health-data'
import { ReportFilterBar } from '../../reports/ReportFilterBar'
import { FinancialHealthView } from './FinancialHealthView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.financialHealth')
  return { title: t('title') }
}

export default async function FinancialHealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('analytics.financialHealth')
  const authz = await requirePermission('reports.read')

  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await healthData({ from: period.from, to: period.to, label: period.label }, authz.user.orgId)

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={period.label} backLabel={t('backToHub')}>
          <ReportFilterBar controls={{ period: true }} />
        </AnalyticsHeader>
      }
    >
      <FinancialHealthView data={data} defs={RATIO_DEFS} />
    </ListPageLayout>
  )
}
