import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { TrendChart } from '../analytics/_ui/charts'
import { SubsidiarySwitcher } from '../../../components/subsidiary-switcher'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { purchasingHome, type VendorExposureRow } from '../../../lib/module-home/purchasing'
import { money, moneyCompact } from '../../../lib/format'

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
  const apItem = groupItems.find((i) => i.href === '/ap')
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = [
    { href: '/purchasing', label: t('home.tabs.overview'), active: true },
    ...(apItem ? [{ href: `${apItem.href}${subQs}`, label: apItem.label }] : []),
  ]

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
        {/* Vitals */}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <HomeStatTile
            icon="wallet"
            accent="indigo"
            label={t('home.vitals.openAp')}
            value={moneyCompact(data.apOutstanding)}
            sub={t('home.vitals.openApSub', { count: data.openBills })}
          />
          <HomeStatTile
            icon="triangle-alert"
            accent="red"
            label={t('home.vitals.overdue')}
            value={moneyCompact(data.apOverdue)}
            tone={data.apOverdue > 0 ? 'negative' : 'positive'}
          />
          <HomeStatTile
            icon="calendar-clock"
            accent="amber"
            label={t('home.vitals.dueNext7')}
            value={moneyCompact(data.dueNext7)}
            tone="warning"
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
            accent="teal"
            label={t('home.vitals.spend30d')}
            value={moneyCompact(data.spend30d)}
            sub={t('home.vitals.spend30dSub')}
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
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('home.hero.vendor')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('home.hero.openPos')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('home.hero.openBills')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('home.hero.oldestDue')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('home.hero.overdue')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('home.hero.billedOpen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topExposure.map((r) => (
                    <tr key={r.partyId ?? r.name} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/ap/bills?q=${encodeURIComponent(r.name)}` as never}
                          className="font-medium text-slate-800 hover:text-teal-700 dark:text-slate-200 dark:hover:text-teal-300"
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.openPos > 0 ? (
                          <span className="text-violet-600 dark:text-violet-400">
                            {moneyCompact(r.openPoValue)}
                            <span className="ml-1 text-[11px] text-slate-400">({r.openPos})</span>
                          </span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {r.openBills > 0 ? r.openBills : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.oldestDue ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.overdue > 0 ? (
                          <span className="text-red-600 dark:text-red-400">{moneyCompact(r.overdue)}</span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {money(r.billedOpen)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </HomePanel>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
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
