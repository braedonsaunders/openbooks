import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { TrendChart } from '../analytics/_ui/charts'
import { SubsidiarySwitcher } from '../../../components/subsidiary-switcher'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { purchasingHome, type VendorExposureRow } from '../../../lib/module-home/purchasing'
import { moneyCompact } from '../../../lib/format'
import { CommitmentsTable } from './CommitmentsTable'

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
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!['ap.read', 'parties.read'].some((p) => can(authz, p))) assertCan(authz, 'ap.read')
  const t = await getTranslations('purchasing')
  const tNav = await getTranslations('nav')
  const sp = await searchParams

  const subView = await reportSubsidiaryView(sp.sub, resolveAsOf())
  const [data, navGroups] = await Promise.all([
    purchasingHome(authz.user.orgId, subView.subsidiary?.ids),
    resolveNav(
      authz.user.orgId,
      (permission) => permission === undefined || can(authz, permission),
      authz.user.role,
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
  const tabs = await groupTabs('purchasing', '/purchasing', { subQs })

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
      case '/expenses':
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

  const attention = needsAttention(data.topExposure, data.badges.unpostedExpenses, t)
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
          <HomeStatTile
            icon="clipboard"
            accent="violet"
            label={t('home.vitals.openPos')}
            value={moneyCompact(data.openPoValue)}
            sub={t('home.vitals.openPosSub', { count: data.openPos })}
          />
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
          <HomeStatTile
            icon="triangle-alert"
            accent="amber"
            label={t('home.vitals.unposted')}
            value={String(data.badges.unpostedExpenses)}
            sub={t('home.vitals.unpostedSub')}
            tone={data.badges.unpostedExpenses > 0 ? 'warning' : 'positive'}
          />
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
            {data.topExposure.length === 0 ? (
              <p className="px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">{t('home.hero.empty')}</p>
            ) : (
              <CommitmentsTable rows={data.topExposure} />
            )}
          </HomePanel>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
            <HomePanel title={t('home.pulse.title')} icon="gauge" bodyClassName="p-0" className="shrink-0">
              <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-800">
                <div className="px-3 py-2.5 text-center">
                  <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{moneyCompact(data.apOutstanding)}</p>
                  <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{t('home.pulse.open')}</p>
                </div>
                <div className="px-3 py-2.5 text-center">
                  <p className={cn('text-sm font-bold tabular-nums', data.apOverdue > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-100')}>
                    {moneyCompact(data.apOverdue)}
                  </p>
                  <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{t('home.pulse.overdue')}</p>
                </div>
                <div className="px-3 py-2.5 text-center">
                  <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{moneyCompact(data.dueNext7)}</p>
                  <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{t('home.pulse.due7')}</p>
                </div>
              </div>
              <Link
                href={`/ap${subQs}` as never}
                className="block border-t border-slate-100 px-4 py-2 text-center text-xs font-semibold text-teal-600 transition-colors hover:text-teal-700 dark:border-slate-800 dark:text-teal-400 dark:hover:text-teal-300"
              >
                {t('home.pulse.cta')} →
              </Link>
            </HomePanel>

            <HomePanel title={t('home.trend.title')} icon="area-chart" hint={t('home.trend.hint')} className="shrink-0">
              <TrendChart
                labels={trendLabels}
                series={[{ name: t('home.trend.series'), data: data.trend.map((w) => w.spend), color: '#ef4444' }]}
                height={170}
                area
              />
            </HomePanel>

            {directory.length > 0 ? (
              <div className="shrink-0">
                <h3 className="mb-2 px-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {t('home.directory.title')}
                </h3>
                <LiveDirectory items={directory} />
              </div>
            ) : null}

            <HomePanel title={t('home.attention.title')} icon="triangle-alert" bodyClassName="p-0" className="shrink-0">
              {attention.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                  {t('home.attention.allClear')}
                </p>
              ) : (
                <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
                  {attention.map((item, i) => (
                    <li key={i}>
                      <Link
                        href={item.href as never}
                        className="flex items-start gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <span
                          className={cn(
                            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                            item.tone === 'negative' ? 'bg-red-500' : 'bg-amber-500',
                          )}
                        />
                        <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">{item.text}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </HomePanel>
          </div>
        </div>
      </div>
    </ListPageLayout>
  )
}

type T = Awaited<ReturnType<typeof getTranslations<'purchasing'>>>

function needsAttention(exposure: VendorExposureRow[], unpostedExpenses: number, t: T) {
  const items: { tone: 'negative' | 'warning'; text: string; href: string }[] = []
  for (const r of exposure) {
    if (r.overdue > 0) {
      items.push({
        tone: r.overdue > r.billedOpen / 2 ? 'negative' : 'warning',
        text: t('home.attention.overdueVendor', { vendor: r.name, amount: moneyCompact(r.overdue) }),
        href: '/ap',
      })
    }
  }
  if (unpostedExpenses > 0) {
    items.push({ tone: 'warning', text: t('home.attention.unpostedExpenses', { count: unpostedExpenses }), href: '/expenses' })
  }
  return items.slice(0, 6)
}

function weekLabel(weekStart: string): string {
  return new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
