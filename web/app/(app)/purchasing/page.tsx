import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { TrendChart } from '../analytics/_ui/charts'
import { SubsidiarySwitcher } from '../../../components/subsidiary-switcher'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { purchasingHome } from '../../../lib/module-home/purchasing'
import { getMoneyFormatter } from '@/lib/money-server'
import { ApPulse, AttentionList, CommitmentsSection, DirectorySection } from './sections'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPurchasing, purchasingSpec, needsAttention, weekLabel } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('purchasing')
  return { title: t('home.title') }
}

/**
 * Purchasing module home — the buy-to-pay workspace landing the nav group
 * header opens. The vendor commitments board (open POs beside open bills) is
 * the hero; the rail carries the 13-week spend trend, the live directory, and
 * the needs-attention queue. Tabs are ROUTES (the /ap idiom): the AP cockpit
 * stays its own page and appears here as a sibling tab when the org's nav
 * shows it.
 */
export default async function PurchasingHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const spec = await searchParams
    const data = await loadPurchasing(spec)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={purchasingSpec(data)} data={data} searchParams={spec} trusted />
      </>
    )
  }
  const { moneyCompact } = await getMoneyFormatter()
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!['ap.read', 'parties.read'].some((p) => can(authz, p))) assertCan(authz, 'ap.read')
  const t = await getTranslations('purchasing')
  const tNav = await getTranslations('nav')
  const sp = await searchParams

  const subView = await reportSubsidiaryView(sp.sub, await resolveAsOf(authz.user.orgId))
  const [data, navGroups] = await Promise.all([
    purchasingHome(authz.user.orgId, subView.subsidiary?.ids),
    resolveNav(
      authz.user.orgId,
      (permission) => permission === undefined || can(authz, permission),
      authz.user.roles.map(({ key }) => key),
      (key) => {
        try {
          return tNav(key)
        } catch {
          return ''
        }
      },
    ),
  ])

  const groupItems = navGroups.find((g) => g.id === 'purchasing')?.items ?? []
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = await groupTabs('purchasing', '/purchasing', { subQs, orgId: authz.user.orgId })

  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/purchase-orders':
        return { value: String(data.badges.openPos), hint: t('home.directory.posHint', { value: moneyCompact(data.openPoValue) }) }
      case '/ap/bills':
        return {
          value: String(data.badges.openBills),
          hint: t('home.directory.billsHint', { overdue: moneyCompact(data.apOverdue) }),
          tone: data.apOverdue > 0 ? 'warning' : 'neutral',
        }
      case '/payments':
        return { value: String(data.badges.payments7d), hint: t('home.directory.paymentsHint') }
      case '/expenses/reports':
        return {
          value: String(data.badges.unpostedExpenses),
          hint: t('home.directory.expensesHint'),
          tone: data.badges.unpostedExpenses > 0 ? 'warning' : 'positive',
        }
      case '/entities/vendors':
        return { value: String(data.badges.vendors), hint: t('home.directory.vendorsHint') }
      default:
        return undefined
    }
  }
  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/purchasing' && i.href !== '/ap')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  const attention = needsAttention(
    data.topExposure,
    data.expensesEnabled ? data.badges.unpostedExpenses : 0,
    t,
    moneyCompact,
  )
  const trendLabels = data.trend.map((w) => weekLabel(w.weekStart))

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('home.title')}
          description={t('home.description')}
          actions={
            <div className="flex items-center gap-3">
              <SubsidiarySwitcher
                picker={subView.picker}
                value={subView.picker.find((p) => p.id === sp.sub)?.id ?? subView.picker[0]?.id ?? ''}
                label={t('home.subsidiary')}
              />
              <ModuleHomeTabs tabs={tabs} />
            </div>
          }
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        {/* Vitals — workspace-level (order cycle + spend). The payables
            figures live on the AP cockpit; here they are one compact pulse
            panel in the rail, not a second dashboard. */}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <HomeStatTile
            icon="building"
            accent="teal"
            label={t('home.vitals.activeVendors')}
            value={String(data.badges.vendors)}
          />
          {data.ordersEnabled ? (
          <HomeStatTile
            icon="clipboard"
            accent="violet"
            label={t('home.vitals.openPos')}
            value={moneyCompact(data.openPoValue)}
            sub={t('home.vitals.openPosSub', { count: data.openPos })}
          />
          ) : null}
          <HomeStatTile
            icon="trending-up"
            accent="sky"
            label={t('home.vitals.spend30d')}
            value={moneyCompact(data.spend30d)}
            sub={t('home.vitals.spend30dSub')}
          />
          <HomeStatTile
            icon="check-circle"
            accent="emerald"
            label={t('home.vitals.paymentsWeek')}
            value={moneyCompact(data.badges.paid7dValue)}
            sub={t('home.vitals.paymentsWeekSub', { count: data.badges.payments7d })}
            tone="positive"
          />
          {data.expensesEnabled ? (
          <HomeStatTile
            icon="triangle-alert"
            accent="amber"
            label={t('home.vitals.unposted')}
            value={String(data.badges.unpostedExpenses)}
            sub={t('home.vitals.unpostedSub')}
            tone={data.badges.unpostedExpenses > 0 ? 'warning' : 'positive'}
          />
          ) : null}
        </div>

        {/* Commitments hero + supporting rail */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
          <HomePanel
            title={t('home.hero.title')}
            icon="building"
            hint={t('home.hero.hint')}
            bodyClassName="min-h-0 overflow-y-auto p-0"
            className="min-h-[24rem] lg:col-span-2"
          >
            <CommitmentsSection
              rows={data.topExposure}
              showPurchaseOrders={data.ordersEnabled}
              empty={t('home.hero.empty')}
            />
          </HomePanel>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
            <HomePanel title={t('home.pulse.title')} icon="gauge" bodyClassName="p-0" className="shrink-0">
              <ApPulse
                outstanding={moneyCompact(data.apOutstanding)}
                overdue={moneyCompact(data.apOverdue)}
                dueNext7={moneyCompact(data.dueNext7)}
                overdueIsNegative={data.apOverdue > 0}
                labels={{
                  open: t('home.pulse.open'),
                  overdue: t('home.pulse.overdue'),
                  due7: t('home.pulse.due7'),
                  cta: t('home.pulse.cta'),
                }}
                href={`/ap${subQs}`}
              />
            </HomePanel>

            <HomePanel title={t('home.trend.title')} icon="area-chart" hint={t('home.trend.hint')} className="shrink-0">
              <TrendChart
                labels={trendLabels}
                series={[{ name: t('home.trend.series'), data: data.trend.map((w) => w.spend), color: '#ef4444' }]}
                height={170}
                area
              />
            </HomePanel>

            <DirectorySection items={directory} title={t('home.directory.title')} />

            <HomePanel title={t('home.attention.title')} icon="triangle-alert" bodyClassName="p-0" className="shrink-0">
              <AttentionList items={attention} allClear={t('home.attention.allClear')} />
            </HomePanel>
          </div>
        </div>
      </div>
    </ListPageLayout>
  )
}

