import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { SubsidiarySwitcher } from '../../../../components/subsidiary-switcher'
import { requirePermission, can } from '../../../../lib/authz'
import { analyticsConfig } from '../../../../lib/analytics/config'
import { cashPosition } from '../../../../lib/cash/cash-position'
import { resolveAsOf } from '../../../../lib/cash/core'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
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
  const tBanking = await getTranslations('banking')

  const sp = await searchParams
  const parsed = Number(sp.horizon)
  const horizon = parsed === 4 || parsed === 12 ? parsed : 8

  // Subsidiary context (multi-subsidiary orgs): the whole cockpit — cash,
  // open items, SQL-backed forecast categories — scopes to the selected view.
  const asOfIso = resolveAsOf()
  const subView = await reportSubsidiaryView(sp.sub, asOfIso)

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const data = await cashPosition(authz.user.orgId, horizon, apSettings, undefined, subView.subsidiary?.ids)

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <div className="flex items-center gap-3">
              <SubsidiarySwitcher
                picker={subView.picker}
                value={subView.picker.find((p) => p.id === sp.sub)?.id ?? subView.picker[0]?.id ?? ''}
                label={tBanking('home.subsidiary')}
              />
              {/* Sibling route-tabs back to the Banking module home (the /ap idiom). */}
              <ModuleHomeTabs
                tabs={[
                  { href: sp.sub ? `/banking?sub=${sp.sub}` : '/banking', label: tBanking('home.tabs.overview') },
                  { href: '/banking/cash', label: t('title'), active: true },
                ]}
              />
            </div>
          }
        />
      }
    >
      <CashCockpit
        data={data}
        canConfigure={can(authz, 'admin.setup.manage')}
        canPayRun={can(authz, 'ap.pay')}
        canCollectionRun={can(authz, 'ar.pay')}
      />
    </ListPageLayout>
  )
}
