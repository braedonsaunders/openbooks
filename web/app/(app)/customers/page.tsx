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
import { customersHome, type CustomerExposureRow } from '../../../lib/module-home/customers'
import { money, moneyCompact } from '../../../lib/format'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('customers')
  return { title: t('home.title') }
}

/**
 * Customers module home — the relationship-to-cash workspace landing the nav
 * group header opens. The top open-balance relationships are the hero; the
 * rail carries the 13-week collections trend, the live directory, and the
 * needs-attention queue. Tabs are ROUTES (the /ap idiom): the AR cockpit
 * stays its own page and appears here as a sibling tab when the org's nav
 * shows it.
 */
export default async function CustomersHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  // The workspace spans CRM + AR + records — any of the group's read
  // permissions opens the home; panels stay org-wide counts.
  if (!['ar.read', 'crm.read', 'parties.read'].some((p) => can(authz, p))) assertCan(authz, 'ar.read')
  const t = await getTranslations('customers')
  const tNav = await getTranslations('nav')
  const sp = await searchParams

  const subView = await reportSubsidiaryView(sp.sub, resolveAsOf())
  const [data, navGroups] = await Promise.all([
    customersHome(authz.user.orgId, subView.subsidiary?.ids),
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

  const groupItems = navGroups.find((g) => g.id === 'customers')?.items ?? []
  const arItem = groupItems.find((i) => i.href === '/ar')
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = [
    { href: '/customers', label: t('home.tabs.overview'), active: true },
    ...(arItem ? [{ href: `${arItem.href}${subQs}`, label: arItem.label }] : []),
  ]

  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/crm/opportunities':
        return { value: String(data.badges.openOpportunities), hint: t('home.directory.opportunitiesHint') }
      case '/estimates':
        return { value: String(data.badges.openQuotes), hint: t('home.directory.estimatesHint') }
      case '/sales-orders':
        return { value: String(data.badges.openSalesOrders), hint: t('home.directory.salesOrdersHint') }
      case '/ar/invoices':
        return {
          value: String(data.openInvoices),
          hint: t('home.directory.invoicesHint', { overdue: data.overdueInvoices }),
          tone: data.overdueInvoices > 0 ? 'warning' : 'neutral',
        }
      case '/receipts':
        return { value: String(data.badges.receipts7d), hint: t('home.directory.receiptsHint') }
      case '/entities/customers':
        return { value: String(data.badges.customers), hint: t('home.directory.customersHint') }
      default:
        return undefined
    }
  }
  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/customers' && i.href !== '/ar')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  const attention = needsAttention(data.topExposure, t)
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
            accent="sky"
            label={t('home.vitals.openAr')}
            value={moneyCompact(data.arOutstanding)}
            sub={t('home.vitals.openArSub', { count: data.openInvoices })}
          />
          <HomeStatTile
            icon="triangle-alert"
            accent="red"
            label={t('home.vitals.overdue')}
            value={moneyCompact(data.arOverdue)}
            sub={t('home.vitals.overdueSub', { count: data.overdueInvoices })}
            tone={data.arOverdue > 0 ? 'negative' : 'positive'}
          />
          <HomeStatTile
            icon="trending-up"
            accent="violet"
            label={t('home.vitals.pipeline')}
            value={moneyCompact(data.pipeline.total)}
            sub={t('home.vitals.pipelineSub', { weighted: moneyCompact(data.pipeline.weighted) })}
          />
          <HomeStatTile
            icon="check-circle"
            accent="emerald"
            label={t('home.vitals.closedQuarter')}
            value={moneyCompact(data.pipeline.closed)}
            tone="positive"
          />
          <HomeStatTile
            icon="timer"
            accent="teal"
            label={t('home.vitals.dso')}
            value={data.dsoLite === null ? '—' : t('home.vitals.days', { n: data.dsoLite })}
            sub={t('home.vitals.dsoSub')}
          />
        </div>

        {/* Relationship hero + supporting rail */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
          <HomePanel
            title={t('home.hero.title')}
            icon="users"
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
                    <th className="px-4 py-2 text-left font-medium">{t('home.hero.customer')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('home.hero.openOpps')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('home.hero.openInvoices')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('home.hero.oldestDue')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('home.hero.overdue')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('home.hero.open')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topExposure.map((r) => (
                    <tr key={r.partyId} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/ar/invoices?q=${encodeURIComponent(r.name)}` as never}
                          className="font-medium text-slate-800 hover:text-teal-700 dark:text-slate-200 dark:hover:text-teal-300"
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {r.openOpportunities > 0 ? (
                          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 tabular-nums dark:bg-violet-950/50 dark:text-violet-300">
                            {r.openOpportunities}
                          </span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400">{r.openInvoices}</td>
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.oldestDue ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.overdue > 0 ? (
                          <span className="text-red-600 dark:text-red-400">{moneyCompact(r.overdue)}</span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(r.open)}</td>
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
                series={[{ name: t('home.trend.series'), data: data.trend.map((w) => w.collected), color: '#10b981' }]}
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

type T = Awaited<ReturnType<typeof getTranslations<'customers'>>>

function needsAttention(exposure: CustomerExposureRow[], t: T) {
  const items: { tone: 'negative' | 'warning'; text: string; href: string }[] = []
  for (const r of exposure) {
    if (r.overdue > 0) {
      items.push({
        tone: r.overdue > r.open / 2 ? 'negative' : 'warning',
        text: t('home.attention.overdueCustomer', { customer: r.name, amount: moneyCompact(r.overdue) }),
        href: '/ar',
      })
    }
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
