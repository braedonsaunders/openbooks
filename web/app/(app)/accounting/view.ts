import 'server-only'

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { resolvePeriod } from '../../../lib/periods'
import { financialHealth, RATIO_DEFS, type RatioResult } from '../../../lib/analytics/financial-health'
import { accountingHome } from '../../../lib/module-home/accounting'
import { getMoneyFormatter } from '@/lib/money-server'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'
import type { AttentionItem, HealthCategoryRow, HealthRatioRow } from './sections'

/**
 * The accounting cockpit, split into a loader and a spec.
 *
 * Same archetype as /purchasing: ViewSpec composes the GRID and the PANELS;
 * the panel bodies stay components in ./sections, shared by the page and the widget registry
 * so they cannot drift. The Financial Health hero body (gauge + category bars
 * + ratio table + deep link) is one bespoke `health-hero` widget rather than
 * blocks: its ratio table is a plain `<table>` with native classes the spec's
 * table block cannot express, and the gauge is a client SVG component.
 *
 * Query, permission and formatting logic below are verbatim from page.tsx.
 */

type Tabs = Awaited<ReturnType<typeof groupTabs>>

export interface AccountingData {
  title: string
  description: string
  tabs: Tabs
  healthAccent: 'emerald' | 'amber' | 'red'
  healthScoreLabel: string
  healthScoreValue: string
  healthScoreSub: string
  healthScoreTone: 'positive' | 'warning' | 'negative'
  netIncomeAccent: 'teal' | 'red'
  netIncomeLabel: string
  netIncomeValue: string
  netIncomeSub: string
  netIncomeTone: 'positive' | 'negative'
  closeLabel: string
  closeValue: string
  closeSub: string
  draftLabel: string
  draftValue: string
  draftSub: string
  draftAccent: 'amber' | 'emerald'
  draftTone: 'warning' | 'positive'
  findingsLabel: string
  findingsValue: string
  findingsSub: string
  findingsAccent: 'red' | 'amber' | 'emerald'
  findingsTone: 'negative' | 'warning' | 'positive'
  heroTitle: string
  heroHint: string
  gaugeValue: number
  gaugeLabel: string
  categories: HealthCategoryRow[]
  ratios: HealthRatioRow[]
  ratioLabels: { ratio: string; value: string; benchmark: string; grade: string }
  fullAnalysisLabel: string
  directoryTitle: string
  hasDirectory: boolean
  directory: DirectoryItem[]
  attentionTitle: string
  attentionAllClear: string
  attention: AttentionItem[]
}

export async function loadAccounting(
  sp: Record<string, string | string[] | undefined>,
): Promise<AccountingData> {
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

  const attention: AttentionItem[] = []
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

  return {
    title: t('home.title'),
    description: t('home.description'),
    tabs,
    healthAccent: health.overallScore >= 60 ? 'emerald' : health.overallScore >= 40 ? 'amber' : 'red',
    healthScoreLabel: t('home.vitals.healthScore'),
    healthScoreValue: String(Math.round(health.overallScore)),
    healthScoreSub: t(`home.score.${health.scoreLabel}`),
    healthScoreTone: health.overallScore >= 60 ? 'positive' : health.overallScore >= 40 ? 'warning' : 'negative',
    netIncomeAccent: health.figures.netIncome >= 0 ? 'teal' : 'red',
    netIncomeLabel: t('home.vitals.netIncome'),
    netIncomeValue: moneyCompact(health.figures.netIncome),
    netIncomeSub: period.label,
    netIncomeTone: health.figures.netIncome >= 0 ? 'positive' : 'negative',
    closeLabel: t('home.vitals.close'),
    closeValue: data.close.progressPct === null ? t('home.vitals.noClose') : `${data.close.progressPct}%`,
    closeSub: data.close.periodName ? t('home.vitals.closeSub', { period: data.close.periodName }) : t('home.vitals.noCloseSub'),
    draftLabel: t('home.vitals.draftJournals'),
    draftValue: data.draftJournals.toLocaleString(),
    draftSub: t('home.vitals.draftJournalsSub', { posted: data.postedJournals7d }),
    draftAccent: data.draftJournals > 0 ? 'amber' : 'emerald',
    draftTone: data.draftJournals > 0 ? 'warning' : 'positive',
    findingsLabel: t('home.vitals.openFindings'),
    findingsValue: data.workItems.total.toLocaleString(),
    findingsSub: t('home.vitals.openFindingsSub', { critical: data.workItems.critical }),
    findingsAccent: data.workItems.critical > 0 ? 'red' : data.workItems.total > 0 ? 'amber' : 'emerald',
    findingsTone: data.workItems.critical > 0 ? 'negative' : data.workItems.total > 0 ? 'warning' : 'positive',
    heroTitle: t('home.hero.title'),
    heroHint: period.label,
    gaugeValue: health.overallScore,
    gaugeLabel: t(`home.score.${health.scoreLabel}`),
    categories: health.categoryScores.map((c) => ({
      key: c.key,
      label: t(`home.categories.${c.key}`),
      score: c.score,
    })),
    ratios: gradedRatios.map((r) => ({
      id: r.id,
      label: RATIO_DEFS[r.id]?.label ?? r.id,
      calc: r.calc,
      value: fmtRatio(r.value, r.format, moneyCompact),
      benchmark: fmtRatio(r.benchmark, r.format, moneyCompact),
      grade: r.grade ?? '—',
      score: r.score,
    })),
    ratioLabels: {
      ratio: t('home.hero.ratio'),
      value: t('home.hero.value'),
      benchmark: t('home.hero.benchmark'),
      grade: t('home.hero.grade'),
    },
    fullAnalysisLabel: t('home.hero.fullAnalysis'),
    directoryTitle: t('home.directory.title'),
    hasDirectory: directory.length > 0,
    directory,
    attentionTitle: t('home.attention.title'),
    attentionAllClear: t('home.attention.allClear'),
    // Capped where the native call site caps it: the rail shows six.
    attention: attention.slice(0, 6),
  }
}

const f = ref<AccountingData>()

export function accountingSpec(data: AccountingData): PageSpec {
  return page({
    route: '/accounting',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        // Vitals strip. Tones and accents are loader-resolved strings; the
        // tiles render the same HomeStatTile both paths use.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({
            iconKey: 'heart-pulse',
            accent: f('healthAccent'),
            label: f('healthScoreLabel'),
            value: f('healthScoreValue'),
            sub: f('healthScoreSub'),
            tone: f('healthScoreTone'),
          }),
          statTile({
            iconKey: 'trending-up',
            accent: f('netIncomeAccent'),
            label: f('netIncomeLabel'),
            value: f('netIncomeValue'),
            sub: f('netIncomeSub'),
            tone: f('netIncomeTone'),
          }),
          statTile({
            iconKey: 'check-circle',
            accent: 'violet',
            label: f('closeLabel'),
            value: f('closeValue'),
            sub: f('closeSub'),
          }),
          statTile({
            iconKey: 'list-checks',
            accent: f('draftAccent'),
            label: f('draftLabel'),
            value: f('draftValue'),
            sub: f('draftSub'),
            tone: f('draftTone'),
          }),
          statTile({
            iconKey: 'triangle-alert',
            accent: f('findingsAccent'),
            label: f('findingsLabel'),
            value: f('findingsValue'),
            sub: f('findingsSub'),
            tone: f('findingsTone'),
          }),
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          panel({
            title: f('heroTitle'),
            iconKey: 'heart-pulse',
            hint: f('heroHint'),
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-[24rem] lg:col-span-2',
            blocks: [
              // The hero body (gauge + category bars + ratio table + deep
              // link) is one widget: its table is a plain hand-styled
              // <table>, not either spec table variant, and the gauge is a
              // client SVG component. See ./sections.
              widgetBlock('health-hero', {
                gaugeValue: data.gaugeValue,
                gaugeLabel: data.gaugeLabel,
                categories: data.categories,
                ratios: data.ratios,
                ratioLabels: data.ratioLabels,
                fullAnalysisLabel: data.fullAnalysisLabel,
              }),
            ],
          }),

          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            {
              ...widgetBlock('directory-section', { items: data.directory, title: data.directoryTitle }),
              when: f('hasDirectory'),
            },
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('attention-list', {
                  items: data.attention,
                  allClear: data.attentionAllClear,
                }),
              ],
            }),
          ]),
        ]),
      ]),
    ],
  })
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
