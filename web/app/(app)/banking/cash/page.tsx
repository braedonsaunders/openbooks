import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission, can } from '../../../../lib/authz'
import { analyticsConfig } from '../../../../lib/analytics/config'
import { cashPosition } from '../../../../lib/cash/cash-position'
import { CashCockpit } from './CashCockpit'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking.cash')
  return { title: t('title') }
}

/**
 * Cash control center — whole-company liquidity off the shared cash engine.
 * Operational counterpart to analytics/cashflow: this page is where you act on
 * cash (runway, lowest point, the weekly timeline with per-week drill and the
 * forecast config); the analytics dashboard is where you explain it.
 */
export default async function BankingCashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking.cash')

  const sp = await searchParams
  const parsed = Number(sp.horizon)
  const horizon = parsed === 4 || parsed === 12 ? parsed : 8

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const data = await cashPosition(authz.user.orgId, horizon, apSettings)

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={<PageHeader title={t('title')} description={t('description')} />}
    >
      <CashCockpit data={data} canConfigure={can(authz, 'admin.setup.manage')} />
    </ListPageLayout>
  )
}
