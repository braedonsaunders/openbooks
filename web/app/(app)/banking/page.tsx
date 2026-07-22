import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ListChecks } from 'lucide-react'
import { Button, cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { AccountsRosterPanel } from './AccountsRoster'
import { TrendChart } from '../analytics/_ui/charts'
import { SubsidiarySwitcher } from '../../../components/subsidiary-switcher'
import { requirePermission, can } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { bankingHome, type BankingAccountRow } from '../../../lib/module-home/banking'
import { userPageLayout } from '../../../lib/page-layout'
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('home.title') }
}

/** Statements older than this are flagged as a stale feed on the roster. */
const STALE_STATEMENT_DAYS = 30

/**
 * Banking module home — the workspace landing cockpit the nav group header
 * opens. The account roster is the hero (the page's headline object); the
 * rail carries the 13-week cash trend, the live directory (the rest of the
 * workspace's pages annotated with what needs doing there), and a
 * needs-attention queue. Tabs are ROUTES (the /ap idiom): the Cash Position
 * cockpit stays its own page and appears here as a sibling tab when the org's
 * nav shows it.
 */
export default async function BankingHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { moneyCompact } = await getMoneyFormatter()
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  const tNav = await getTranslations('nav')
  const sp = await searchParams

  // Subsidiary context — multi-subsidiary orgs get a switcher; the whole page
  // (roster, balances, trend, badges) scopes to the selected view.
  const subView = await reportSubsidiaryView(sp.sub, resolveAsOf())

  const [data, rosterPrefs, navGroups] = await Promise.all([
    bankingHome(authz.user.orgId, subView.subsidiary?.ids),
    userPageLayout(authz.user.id, 'banking-accounts'),
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

  // The home reflects the org's OWN menu: tabs and directory come from the
  // resolved banking group, so hidden items vanish and custom labels hold.
  const groupItems = navGroups.find((g) => g.id === 'banking')?.items ?? []
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = await groupTabs('banking', '/banking', { subQs })

  const lastImportAge = daysSince(data.badges.lastImportedAt)
  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/banking/match':
        return data.unmatchedLines > 0
          ? { value: String(data.unmatchedLines), hint: t('home.directory.matchHint'), tone: 'warning' }
          : { value: '0', hint: t('home.directory.matchClear'), tone: 'positive' }
      case '/banking/reconciliations':
        return {
          value: String(data.openRecons),
          hint: t('home.directory.reconsHint'),
          tone: data.openRecons > 0 ? 'neutral' : 'positive',
        }
      case '/banking/rules':
        return {
          value: String(data.badges.activeRules),
          hint: t('home.directory.rulesHint', { total: data.badges.totalRules }),
        }
      case '/banking/imports':
        return {
          value: String(data.badges.statements),
          hint:
            data.badges.lastImportedAt === null
              ? t('home.directory.importsNever')
              : t('home.directory.importsHint', { days: lastImportAge ?? 0 }),
          tone: lastImportAge !== null && lastImportAge > STALE_STATEMENT_DAYS ? 'warning' : 'neutral',
        }
      case '/banking/transactions':
        return { value: String(data.badges.txns7d), hint: t('home.directory.transactionsHint') }
      default:
        return undefined
    }
  }
  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/banking' && i.href !== '/banking/cash')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  const banks = data.accounts.filter((a) => a.type === 'asset_bank')
  const cards = data.accounts.filter((a) => a.type !== 'asset_bank')
  const attention = needsAttention(data.accounts, t)

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
              {canReconcile ? (
                <Button variant={data.unmatchedLines > 0 ? 'default' : 'outline'} asChild>
                  <Link href={'/banking/match' as never}>
                    <ListChecks size={14} />
                    {data.unmatchedLines > 0
                      ? t('home.actions.matchCount', { count: data.unmatchedLines })
                      : t('home.actions.match')}
                  </Link>
                </Button>
              ) : null}
            </div>
          }
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        {/* Vitals */}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <HomeStatTile
            icon="landmark"
            accent="indigo"
            label={t('home.vitals.cash')}
            value={moneyCompact(data.totalCash)}
            sub={t('home.vitals.accountCount', { count: banks.length })}
            tone={data.totalCash < 0 ? 'negative' : 'neutral'}
          />
          <HomeStatTile
            icon="credit-card"
            accent="violet"
            label={t('home.vitals.cards')}
            value={moneyCompact(data.totalCards)}
            sub={t('home.vitals.accountCount', { count: cards.length })}
          />
          <HomeStatTile
            icon="list-checks"
            accent={data.unmatchedLines > 0 ? 'amber' : 'emerald'}
            label={t('home.vitals.unmatched')}
            value={data.unmatchedLines.toLocaleString()}
            sub={data.unmatchedLines > 0 ? t('home.vitals.unmatchedSub') : t('home.vitals.allMatched')}
            tone={data.unmatchedLines > 0 ? 'warning' : 'positive'}
          />
          <HomeStatTile
            icon="check-circle"
            accent="teal"
            label={t('home.vitals.openRecons')}
            value={data.openRecons.toLocaleString()}
            sub={data.openRecons > 0 ? t('home.vitals.openReconsSub') : t('home.vitals.noneOpen')}
          />
          <HomeStatTile
            icon="arrow-left-right"
            accent={data.netFlow7d >= 0 ? 'emerald' : 'red'}
            label={t('home.vitals.netFlow')}
            value={moneyCompact(data.netFlow7d)}
            tone={data.netFlow7d >= 0 ? 'positive' : 'negative'}
          />
        </div>

        {/* Roster hero + supporting rail */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
          <AccountsRosterPanel
            accounts={data.accounts}
            totalCash={data.totalCash}
            totalCards={data.totalCards}
            layoutPrefs={rosterPrefs}
          />

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
            <HomePanel title={t('home.trend.title')} icon="area-chart" hint={t('home.trend.hint')} className="shrink-0">
              <TrendChart
                labels={trendLabels}
                series={[{ name: t('home.trend.series'), data: data.trend.map((w) => w.balance) }]}
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

            <HomePanel
              title={t('home.attention.title')}
              icon="triangle-alert"
              bodyClassName="p-0"
              className="shrink-0"
            >
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
                            item.tone === 'negative' ? 'bg-red-500' : item.tone === 'warning' ? 'bg-amber-500' : 'bg-teal-500',
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

/* ------------------------------------------------------------------------- */

type T = Awaited<ReturnType<typeof getTranslations<'banking'>>>

function needsAttention(accounts: BankingAccountRow[], t: T) {
  const items: { tone: 'negative' | 'warning' | 'neutral'; text: string; href: string }[] = []
  for (const a of accounts) {
    if (a.type === 'asset_bank' && a.balance < 0) {
      items.push({ tone: 'negative', text: t('home.attention.negativeBalance', { account: a.name }), href: `/banking/${a.id}` })
    }
  }
  for (const a of accounts) {
    const age = daysSince(a.lastImportedAt)
    if (a.lastStatementDate === null) {
      items.push({ tone: 'warning', text: t('home.attention.noStatement', { account: a.name }), href: `/banking/${a.id}` })
    } else if (age !== null && age > STALE_STATEMENT_DAYS) {
      items.push({
        tone: 'warning',
        text: t('home.attention.staleStatement', { account: a.name, days: age }),
        href: `/banking/${a.id}`,
      })
    }
  }
  for (const a of accounts) {
    if (a.openReconciliationId) {
      items.push({
        tone: 'neutral',
        text: t('home.attention.openRecon', { account: a.name }),
        href: `/banking/${a.id}/reconcile/${a.openReconciliationId}`,
      })
    }
  }
  return items.slice(0, 6)
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

function weekLabel(weekStart: string): string {
  return new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
