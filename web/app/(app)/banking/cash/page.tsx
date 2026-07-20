import { getTranslations } from 'next-intl/server'
import { PageContainer } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
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
 * cash (runway, lowest point, the weekly timeline), the analytics dashboard is
 * where you explain it.
 */
export default async function BankingCashPage() {
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking.cash')

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const data = await cashPosition(authz.user.orgId, 8, apSettings)

  return (
    <PageContainer>
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>
      <CashCockpit data={data} />
    </PageContainer>
  )
}
