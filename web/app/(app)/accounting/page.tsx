import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomeStatTile, HomePanel } from '../../../components/module-home/client'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAccounting, accountingSpec } from './view'
import { HealthHero } from './sections'
// The shared attention rail — one implementation for the cockpits that use
// it. The six-row cap is a DATA decision, so it happens here and in the
// loader rather than hiding inside the component.
import { AttentionList } from '../purchasing/sections'
import { LiveDirectory, ModuleHomeTabs, type DirectoryItem } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { resolvePeriod } from '../../../lib/periods'
import { financialHealth, RATIO_DEFS, type RatioResult } from '../../../lib/analytics/financial-health'
import { accountingHome } from '../../../lib/module-home/accounting'
import { getMoneyFormatter } from '@/lib/money-server'

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
export default async function AccountingHomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams)?.__viewspec === '1') {
    const sp = (await searchParams) ?? {}
    const data = await loadAccounting(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={accountingSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const { moneyCompact } = await getMoneyFormatter()
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!['gl.read', 'close.read', 'reports.read'].some((p) => can(authz, p))) assertCan(authz, 'gl.read')
  const t = await getTranslations('accounting')
  const tNav = await getTranslations('nav')

  // Same default period as the analytics dashboard, so the score matches it.
  const period = await resolvePeriod(null, { orgId: authz.user.orgId })
  const [data, health, navGroups] = await Promise.all([
    accountingHome(authz.user.orgId),
    financialHealth({ from: period.from, to: period.to, label: period.label }, undefined, authz.user.orgId, authz.allowedSubsidiaryIds),
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

  const groupItems = navGroups.find((g) => g.id === 'accounting')?.items ?? []
  const tabs = await groupTabs('accounting', '/accounting', {
    exclude: can(authz, 'reports.read') ? [] : ['/analytics/financial-health'],
    orgId: authz.user.orgId,
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
            <HealthHero
              gaugeValue={health.overallScore}
              gaugeLabel={t(`home.score.${health.scoreLabel}`)}
              categories={health.categoryScores.map((c) => ({
                key: c.key,
                label: t(`home.categories.${c.key}`),
                score: c.score,
              }))}
              ratios={gradedRatios.map((r) => ({
                id: r.id,
                label: RATIO_DEFS[r.id]?.label ?? r.id,
                calc: r.calc,
                value: fmtRatio(r.value, r.format, moneyCompact),
                benchmark: fmtRatio(r.benchmark, r.format, moneyCompact),
                grade: r.grade ?? '—',
                score: r.score,
              }))}
              ratioLabels={{
                ratio: t('home.hero.ratio'),
                value: t('home.hero.value'),
                benchmark: t('home.hero.benchmark'),
                grade: t('home.hero.grade'),
              }}
              fullAnalysisLabel={t('home.hero.fullAnalysis')}
            />
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
              <AttentionList items={attention.slice(0, 6)} allClear={t('home.attention.allClear')} />
            </HomePanel>
          </div>
        </div>
      </div>
    </ListPageLayout>
  )
}

function fmtRatio(value: number, format: RatioResult['format'], moneyCompact: (value: number) => string): string {
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
