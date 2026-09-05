import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { cashflowData } from '../../../../lib/analytics/cashflow-data'
import { withoutWeekEntries } from '../../../../lib/cash/core'
import { AnalyticsHeader } from '../_ui/AnalyticsHeader'
import { CashflowView } from './CashflowView'
import { HorizonControl } from './HorizonControl'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.cashflow')
  return { title: t('title') }
}

export default async function CashflowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('analytics.cashflow')
  const authz = await requirePermission('reports.read')

  const sp = await searchParams
  const parsed = Number(sp.horizon)
  const horizon = parsed === 8 || parsed === 12 ? parsed : 4

  const position = await cashflowData(authz.user.orgId, horizon, undefined, authz.allowedSubsidiaryIds)
  // Week totals, counts and the per-counterparty aggregate travel with the
  // page; the transactions behind them do not. The week flyout fetches
  // whichever week is opened from /api/cash/week-entries, at full detail.
  const data = { ...position, weeks: withoutWeekEntries(position.weeks) }

  return (
    <ListPageLayout
      header={
        <AnalyticsHeader title={t('title')} periodLabel={`as of ${data.asOf}`} backLabel={t('backToHub')}>
          <HorizonControl value={horizon} />
        </AnalyticsHeader>
      }
    >
      <CashflowView data={data} />
    </ListPageLayout>
  )
}
