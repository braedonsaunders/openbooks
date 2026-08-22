import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { customerData, customerProfitability } from '../../../../lib/analytics/customer-data'
import { ReportFilterBar } from '../../reports/ReportFilterBar'
import { CustomerView } from './CustomerView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.customer')
  return { title: t('title') }
}

export default async function CustomerIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('analytics.customer')
  const authz = await requirePermission('reports.read')

  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const [data, profitability, projectsEnabled] = await Promise.all([
    customerData({ from: period.from, to: period.to, label: period.label }, authz.user.orgId),
    customerProfitability({ from: period.from, to: period.to }, authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'projects'),
  ])

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={period.label} backLabel={t('backToHub')}>
          <ReportFilterBar controls={{ period: true }} />
        </AnalyticsHeader>
      }
    >
      <CustomerView data={data} profitability={profitability} projectsEnabled={projectsEnabled} />
    </ListPageLayout>
  )
}
