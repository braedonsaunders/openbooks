import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ArrowUpRight } from 'lucide-react'
import { cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { Gauge } from '../analytics/_ui/Gauge'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { resolvePeriod } from '../../../lib/periods'
import { financialHealth, RATIO_DEFS, type RatioResult } from '../../../lib/analytics/financial-health'
import { accountingHome } from '../../../lib/module-home/accounting'
import { moneyCompact } from '../../../lib/format'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('accounting')
  return { title: t('home.title') }
}

/**
 * Accounting module home — the financial-control workspace landing the nav
 * group header opens. FINANCIAL HEALTH is the hero: the score gauge with the
 * graded key ratios, served by the light financialHealth() core (the same
 * score math as analytics — the 10-tab deep dive stays there, one tab away).
 * The rail carries close progress, the live directory, and ledger hygiene.
 */
export default async function AccountingHomePage() {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!['gl.read', 'close.read', 'reports.read'].some((p) => can(authz, p))) assertCan(authz, 'gl.read')
  const t = await getTranslations('accounting')
  const tNav = await getTranslations('nav')

  // Same default period as the analytics dashboard, so the score matches it.
  const period = await resolvePeriod(null, { orgId: authz.user.orgId })
  const [data, health, navGroups] = await Promise.all([
    accountingHome(authz.user.orgId),
    financialHealth({ from: period.from, to: period.to, label: period.label }, undefined, authz.user.orgId),
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

  const groupItems = navGroups.find((g) => g.id === 'accounting')?.items ?? []
  const tabs = await groupTabs('accounting', '/accounting', {
    exclude: can(authz, 'reports.read') ? [] : ['/analytics/financial-health'],
  })

  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/journal':
        return {
          value: String(data.draftJournals),
          hint: t('home.directory.journalHint', { posted: data.postedJournals7d }),
          tone: data.draftJournals > 0 ? 'warning' : 'positive',
        }
      case '/accounts':
        return { value: String(data.badges.accounts), hint: t('home.directory.accountsHint') }
      case '/budgets':
        return { value: String(data.badges.budgets), hint: t('home.directory.budgetsHint') }
      case '/assets':
        return { value: String(data.badges.assets), hint: t('home.directory.assetsHint') }
      case '/continuous-close':
        return {
          value: String(data.workItems.total),
          hint: t('home.directory.continuousCloseHint', { critical: data.workItems.critical }),
          tone: data.workItems.critical > 0 ? 'warning' : 'neutral',
        }
      default:
        return undefined
    }
  }
  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/accounting' && i.href !== '/close')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  // Graded ratios across categories, best-covered first (nulls excluded).
  const gradedRatios = Object.values(health.ratios)
    .flat()
    .filter((r): r is RatioResult & { value: number; score: number } => r.value !== null && r.score !== null)
    .sort((a, b) => a.score - b.score)

  const attention: { tone: 'negative' | 'warning'; text: string; href: string }[] = []
  if (data.workItems.critical > 0) {
    attention.push({ tone: 'negative', text: t('home.attention.criticalItems', { count: data.workItems.critical }), href: '/continuous-close' })
  }
  if (data.workItems.warning > 0) {
    attention.push({ tone: 'warning', text: t('home.attention.warningItems', { count: data.workItems.warning }), href: '/continuous-close' })
  }
  if (data.draftJournals > 0) {
    attention.push({ tone: 'warning', text: t('home.attention.draftJournals', { count: data.draftJournals }), href: '/journal' })
  }
  for (const r of gradedRatios.slice(0, 3)) {
    if (r.score < 40) {
      attention.push({
        tone: 'warning',
        text: t('home.attention.weakRatio', { ratio: RATIO_DEFS[r.id]?.label ?? r.id }),
        href: '/analytics/financial-health',
      })
    }
  }

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('home.title')}
          description={t('home.description')}
          actions={<ModuleHomeTabs tabs={tabs} />}
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        {/* Vitals */}
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <HomeStatTile
            icon="heart-pulse"
            accent={health.overallScore >= 60 ? 'emerald' : health.overallScore >= 40 ? 'amber' : 'red'}
            label={t('home.vitals.healthScore')}
            value={String(Math.round(health.overallScore))}
            sub={t(`home.score.${health.scoreLabel}`)}
            tone={health.overallScore >= 60 ? 'positive' : health.overallScore >= 40 ? 'warning' : 'negative'}
          />
          <HomeStatTile
            icon="trending-up"
            accent={health.figures.netIncome >= 0 ? 'teal' : 'red'}
            label={t('home.vitals.netIncome')}
            value={moneyCompact(health.figures.netIncome)}
            sub={period.label}
            tone={health.figures.netIncome >= 0 ? 'positive' : 'negative'}
          />
          <HomeStatTile
            icon="check-circle"
            accent="violet"
            label={t('home.vitals.close')}
            value={data.close.progressPct === null ? t('home.vitals.noClose') : `${data.close.progressPct}%`}
            sub={data.close.periodName ? t('home.vitals.closeSub', { period: data.close.periodName }) : t('home.vitals.noCloseSub')}
          />
          <HomeStatTile
            icon="list-checks"
            accent={data.draftJournals > 0 ? 'amber' : 'emerald'}
            label={t('home.vitals.draftJournals')}
            value={data.draftJournals.toLocaleString()}
            sub={t('home.vitals.draftJournalsSub', { posted: data.postedJournals7d })}
            tone={data.draftJournals > 0 ? 'warning' : 'positive'}
          />
          <HomeStatTile
            icon="triangle-alert"
            accent={data.workItems.critical > 0 ? 'red' : data.workItems.total > 0 ? 'amber' : 'emerald'}
            label={t('home.vitals.openFindings')}
            value={data.workItems.total.toLocaleString()}
            sub={t('home.vitals.openFindingsSub', { critical: data.workItems.critical })}
            tone={data.workItems.critical > 0 ? 'negative' : data.workItems.total > 0 ? 'warning' : 'positive'}
          />
        </div>

        {/* Financial Health hero + supporting rail */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
          <HomePanel
            title={t('home.hero.title')}
            icon="heart-pulse"
            hint={period.label}
            bodyClassName="min-h-0 overflow-y-auto p-0"
            className="min-h-[24rem] lg:col-span-2"
          >
            <div className="flex flex-col items-center gap-2 border-b border-slate-100 px-6 py-5 sm:flex-row sm:gap-8 dark:border-slate-800">
              <Gauge value={health.overallScore} label={t(`home.score.${health.scoreLabel}`)} size={150} thickness={13} showTicks={false} className="shrink-0" />
              <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-1.5 sm:grid-cols-3">
                {health.categoryScores.map((c) => (
                  <div key={c.key}>
                    <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
                      {t(`home.categories.${c.key}`)}
                    </p>
                    <div className="flex items-center gap-2">
                      <span className={cn('text-sm font-bold tabular-nums', c.score >= 60 ? 'text-emerald-600 dark:text-emerald-400' : c.score >= 40 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')}>
                        {Math.round(c.score)}
                      </span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <span
                          className={cn('block h-full rounded-full', c.score >= 60 ? 'bg-emerald-500' : c.score >= 40 ? 'bg-amber-500' : 'bg-red-500')}
                          style={{ width: `${Math.min(100, Math.max(2, c.score))}%` }}
                        />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('home.hero.ratio')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('home.hero.value')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('home.hero.benchmark')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('home.hero.grade')}</th>
                </tr>
              </thead>
              <tbody>
                {gradedRatios.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{RATIO_DEFS[r.id]?.label ?? r.id}</span>
                      <span className="ml-2 hidden text-xs text-slate-400 sm:inline dark:text-slate-500">{r.calc}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">{fmtRatio(r.value, r.format)}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{fmtRatio(r.benchmark, r.format)}</td>
                    <td className="px-4 py-2 text-center">
                      <span className={cn('inline-block w-8 rounded-full py-0.5 text-[11px] font-bold', r.score >= 60 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : r.score >= 40 ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300')}>
                        {r.grade ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
              <Link
                href={'/analytics/financial-health' as never}
                className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400"
              >
                {t('home.hero.fullAnalysis')} <ArrowUpRight size={12} />
              </Link>
            </div>
          </HomePanel>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
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
                  {attention.slice(0, 6).map((item, i) => (
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

function fmtRatio(value: number, format: RatioResult['format']): string {
  switch (format) {
    case 'pct':
      return `${(value * 100).toFixed(1)}%`
    case 'money':
      return moneyCompact(value)
    case 'num':
      return `${value.toFixed(2)}×`
    default:
      return value.toFixed(1)
  }
}
