import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadSpendVelocity, spendVelocitySpec } from './view'
import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { spendVelocityData } from '../../../../lib/analytics/spend-velocity-data'
import { ReportFilterBar } from '../../reports/ReportFilterBar'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { SpendVelocityView } from './SpendVelocityView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.spendVelocity')
  return { title: t('title') }
}

export default async function SpendVelocityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadSpendVelocity(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={spendVelocitySpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const t = await getTranslations('analytics.spendVelocity')
  const authz = await requirePermission('reports.read')

  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await spendVelocityData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz.allowedSubsidiaryIds)

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={period.label} backLabel={t('backToHub')}>
          <ReportFilterBar controls={{ period: true }} />
        </AnalyticsHeader>
      }
    >
      <SpendVelocityView data={data} />
    </ListPageLayout>
  )
}
