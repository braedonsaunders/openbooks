'use client'

import { useAnalyticsTab, AnalyticsTabContent } from '../use-analytics-tab'

import { RecordTabs } from '@/components/module-home/record-tabs'

import { TableCell as SharedTableCell, TableRow as SharedTableRow, TableHead as SharedTableHead, Table as SharedTable, TableHeader as SharedTableHeader, TableBody as SharedTableBody } from "../../reports/ReportTable"
import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Users,
  Crown,
  Gem,
  AlertOctagon,
  BarChart3,
  PieChart as PieIcon,
  Layers,
  DollarSign,
  FileText,
  HandCoins,
  Percent,
  ChevronRight,
  ChevronDown,
  FolderGit2,
  HeartPulse,
  Lightbulb,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Info,
  Grid3x3,
  CalendarClock,
  Undo2,
  Timer,
  Download,
} from 'lucide-react'
import { cn, Select } from '@openbooks/ui'
import type {
  CustomerData,
  CustomerRow,
  Tier,
  Segment,
  RiskLevel,
  Recommendation,
  Insight,
  Profitability,
  ProfitTier,
} from '../../../../lib/analytics/customer-data'
import { Gauge } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { DivergingBar, Donut, GroupedBar } from '../_ui/charts'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { useAnalyticsMoney, fmtPct, ratioNumber, toChartNumber } from '../_ui/format'
import { InteractiveTableRow } from '@/components/interactive-table-row'
import { cmp, neg, sum } from '@openbooks/engine/money'
import type { MoneyValue } from '../../../../lib/money-format'

const TABS = ['overview', 'health', 'segmentation', 'lifetime', 'churn', 'growth', 'profitability', 'configuration'] as const

/* ------------------------------------------------------------ badge styles */
const PROFIT_TIER_STYLE: Record<ProfitTier, string> = {
  high: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  medium: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  low: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  marginal: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  loss: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
/** Margin display bands, always the effective profit-tier cut-offs — never literals. */
export interface MarginBands { high: number; medium: number; low: number }
function marginClass(m: number | null, bands: MarginBands): string {
  if (m === null) return 'text-slate-400 dark:text-slate-500'
  if (m >= bands.high) return 'text-emerald-600 dark:text-emerald-400'
  if (m < 0) return 'text-red-600 dark:text-red-400'
  if (m < bands.low) return 'text-amber-600 dark:text-amber-400'
  return 'text-slate-700 dark:text-slate-300'
}
function marginAccent(m: number | null, bands: MarginBands): 'emerald' | 'sky' | 'violet' | 'amber' | 'red' | 'slate' {
  if (m === null) return 'slate'
  if (m >= bands.high) return 'emerald'
  if (m >= bands.medium) return 'sky'
  if (m >= bands.low) return 'violet'
  if (m >= 0) return 'amber'
  return 'red'
}

const TIER_STYLE: Record<Tier, string> = {
  platinum: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  gold: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  silver: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  bronze: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
}
const TIER_COLOR: Record<Tier, string> = { platinum: '#8b5cf6', gold: '#f59e0b', silver: '#94a3b8', bronze: '#f97316' }

const RISK_STYLE: Record<RiskLevel, string> = {
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  medium: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  high: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  critical: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const SEGMENT_COLOR: Record<Segment, string> = {
  champions: '#8b5cf6',
  loyal: '#14b8a6',
  potential: '#0ea5e9',
  new: '#10b981',
  regular: '#94a3b8',
  hibernating: '#f59e0b',
  'at-risk': '#f97316',
  lost: '#ef4444',
}
const SEGMENT_STYLE: Record<Segment, string> = {
  champions: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  loyal: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  potential: 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  new: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  regular: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  hibernating: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  'at-risk': 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  lost: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const GRADE_STYLE: Record<Exclude<CustomerRow['healthGrade'], null>, string> = {
  'A+': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  A: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  B: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  C: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  F: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const REC_STYLE: Record<Recommendation, string> = {
  'resolve-issues': 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  reactivate: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  'win-back': 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  nurture: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  onboard: 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  reprice: 'bg-pink-100 text-pink-700 dark:bg-pink-950/60 dark:text-pink-300',
  review: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  maintain: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
}

/** RFM 1–5 score chip (the score badges). */
function ScoreChip({ v }: { v: number }) {
  const cls = v >= 5 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : v >= 3 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
  return <span className={cn('inline-block w-5 rounded py-0.5 text-center text-[10px] font-bold', cls)}>{v}</span>
}

/** Tier band widths from the cumulative cut-offs: Platinum takes the top slice, each later tier the band up to its own cut-off. */
function tierBands(cfg: CustomerData['config']) {
  return {
    platinum: cfg.tierPlatinumPct,
    gold: cfg.tierGoldPct - cfg.tierPlatinumPct,
    silver: cfg.tierSilverPct - cfg.tierGoldPct,
    bronze: 100 - cfg.tierSilverPct,
  }
}

function RetentionBadge({ v, bands }: { v: number; bands: { good: number; fair: number } }) {
  // Retention colours follow the shared grade ladder (good at B, fair at D),
  // never a second set of fixed cut-offs.
  const cls = v >= bands.good ? 'text-emerald-600 dark:text-emerald-400' : v >= bands.fair ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
  return <span className={cn('font-semibold tabular-nums', cls)}>{v}%</span>
}

/* -------------------------------------------------------------------- view */
export function CustomerView({
  data: initialData,
  profitability: initialProfitability,
  projectsEnabled = true,
  canConfigure,
}: {
  data: CustomerData
  profitability: Profitability | null
  projectsEnabled?: boolean
  canConfigure?: boolean
}) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const tabs = projectsEnabled ? TABS : TABS.filter((key) => key !== 'profitability')
  const read = useAnalyticsTab('customer-intelligence', { data: initialData, profitability: initialProfitability }, tabs)
  const { tab, setTab } = read
  const { data, profitability } = read.props
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const k = data.kpis
  const intel = data.intelligence
  const openCustomer = (r: Pick<CustomerRow, 'id' | 'name' | 'invoices' | 'revenue' | 'invoicedRevenue' | 'recon'>) =>
    setDrill({
      kind: 'party', id: r.id, name: r.name, sub: t('drill.invoicesRevenue', { invoices: r.invoices, revenue: money(r.revenue) }),
      // Waterfall-signed rows (recognized = invoiced + rows): the bridge
      // stores gap contributions (invoiced − recognized), so the display
      // negates each leg exactly. Deferrals subtract from invoiced;
      // recognition adds back. The shared drawer renders exact strings.
      recon: {
        title: t('recon.title'),
        invoicedLabel: t('table.invoiced'),
        invoiced: r.invoicedRevenue,
        recognizedLabel: t('table.revenue'),
        recognized: r.revenue,
        rows: [
          { label: t('recon.tax'), amount: neg(r.recon.tax) },
          { label: t('recon.credits'), amount: neg(r.recon.credits) },
          { label: t('recon.deferred'), amount: neg(r.recon.timingDeferred) },
          { label: t('recon.recognized'), amount: r.recon.timingRecognized },
          { label: t('recon.voids'), amount: neg(r.recon.voids) },
          { label: t('recon.other'), amount: neg(r.recon.other) },
        ],
      },
    })

  const weightsError = data.weightsError ?? profitability.weightsError ?? null
  return (
    <div className="space-y-5">
      {weightsError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {weightsError}
        </p>
      ) : null}
      {/* Hero */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {intel.score === null ? (
            <p className="px-2 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">{intel.reason}</p>
          ) : (
            <Gauge value={intel.score} label={intel.label} size={132} thickness={12} showTicks={false} />
          )}
        </div>
        <KpiCard icon={Users} accent="sky" label={t('kpi.totalCustomers')} value={String(k.totalCustomers)} sub={t('sub.newInPeriod', { count: k.newCustomers })} />
        <KpiCard icon={Crown} accent="violet" label={t('kpi.champions')} value={String(k.champions)} sub={t('sub.rfmChampions')} />
        <KpiCard icon={Gem} accent="amber" label={t('kpi.projectedClv')} value={money(k.projectedClv)} sub={t('sub.threeYearProjection', { years: data.config.clvYears })} />
        <KpiCard icon={AlertOctagon} accent={k.atRiskCount > 0 ? 'red' : 'emerald'} label={t('kpi.atRisk')} value={String(k.atRiskCount)} sub={money(k.atRiskRevenue)} tone={k.atRiskCount > 0 ? 'negative' : 'positive'} />
      </div>

      {/* Tabs */}
      <RecordTabs label={t('title')} tabs={tabs.map((key) => ({ key: key, label: t(`tabs.${key}`) }))} active={tab} onChange={setTab}>
      <AnalyticsTabContent loading={read.loading} error={read.error} retry={read.retry}>
      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'health' ? <HealthTab data={data} onDrill={openCustomer} /> : null}
        {tab === 'segmentation' ? <SegmentationTab data={data} /> : null}
        {tab === 'lifetime' ? <LifetimeTab data={data} profitability={profitability} projectsEnabled={projectsEnabled} /> : null}
        {tab === 'churn' ? <ChurnTab data={data} /> : null}
        {tab === 'growth' ? <GrowthTab data={data} /> : null}
        {tab === 'profitability' && projectsEnabled && profitability ? <ProfitabilityTab p={profitability} leak={{ share: data.config.profitLeakRevenueSharePct, margin: data.config.profitLeakMarginTarget }} bands={{ high: data.config.profitHighMargin, medium: data.config.profitMediumMargin, low: data.config.profitLowMargin }} /> : null}
        {tab === 'configuration' ? <ConfigurationTab data={data} canEdit={canConfigure ?? false} /> : null}
      </div>
            </AnalyticsTabContent>
      </RecordTabs>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}

/* --------------------------------------------------------------- Overview */
const INSIGHT_ICON: Record<Insight['type'], { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'text-sky-500' },
  warning: { icon: AlertTriangle, cls: 'text-amber-500' },
  success: { icon: CheckCircle2, cls: 'text-emerald-500' },
  alert: { icon: AlertOctagon, cls: 'text-red-500' },
}

function OverviewTab({ data }: { data: CustomerData }) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const k = data.kpis
  const top = [...data.rows].sort((a, b) => cmp(b.revenue, a.revenue)).slice(0, 10)
  const maxSegRevenue = data.segments.reduce((max, s) => (cmp(s.totalRevenue, max) > 0 ? s.totalRevenue : max), "1")

  const metric = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
      <p className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-800 tabular-nums dark:text-slate-100">{value}</p>
      {sub ? <p className="text-[11px] text-slate-400 dark:text-slate-500">{sub}</p> : null}
    </div>
  )

  return (
    <div className="space-y-5">
      {/* Key metrics — the 6-metric grid */}
      <Panel title={t('panels.keyMetrics')} icon={BarChart3}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {metric(t('metrics.avgValue'), money(k.avgCustomerValue), t('metricsSub.perCustomer'))}
          {metric(t('metrics.retention'), k.retentionRate === null ? '—' : `${k.retentionRate}%`, k.retentionRate === null ? t('metricsSub.noRetentionData') : t('metricsSub.retentionProb'))}
          {metric(t('metrics.paymentRate'), k.paymentRate === null ? '—' : `${k.paymentRate}%`, k.paymentRate === null ? t('metricsSub.noPaymentHistory') : t('metricsSub.paidInFull'))}
          {metric(t('metrics.avgDso'), k.avgDaysToPay === null ? '—' : t('sub.daysShort', { days: k.avgDaysToPay }), k.avgDaysToPay === null ? t('metricsSub.noPaymentHistory') : t('metricsSub.daysToPay'))}
          {metric(t('metrics.top10Share', { pct: data.config.topSharePct }), `${k.top10PctShare}%`, t('metricsSub.ofRevenue'))}
          {metric(t('metrics.monthlyGrowth'), `${k.monthlyGrowth >= 0 ? '+' : ''}${k.monthlyGrowth}%`, t('metricsSub.avgMoM'))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.topByRevenue')} icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => toChartNumber(r.revenue))} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title={t('panels.revenueByTier')} icon={PieIcon}>
          <Donut
            data={data.tierBreakdown.filter((x) => cmp(x.revenue, "0") > 0).map((x) => ({ name: t(`tier.${x.tier}`), value: toChartNumber(x.revenue) }))}
            colors={data.tierBreakdown.filter((x) => cmp(x.revenue, "0") > 0).map((x) => TIER_COLOR[x.tier])}
            height={220}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* RFM Segments bars —  */}
        <Panel title={t('panels.rfmSegments')} icon={Grid3x3} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.segments.map((s) => (
              <li key={s.segment} className="flex items-center gap-3 px-4 py-2">
                <span className={cn('w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold', SEGMENT_STYLE[s.segment])}>{t(`segment.${s.segment}`)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded-full" style={{ width: `${ratioNumber(s.totalRevenue, maxSegRevenue, 0) * 100}%`, backgroundColor: SEGMENT_COLOR[s.segment] }} />
                </div>
                <span className="w-14 text-right text-xs text-slate-500 tabular-nums dark:text-slate-400">{s.count} · {s.percentage}%</span>
                <span className="w-16 text-right text-xs font-medium text-slate-700 tabular-nums dark:text-slate-300">{money(s.totalRevenue)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        {/* Intelligence Insights —  */}
        <Panel title={t('panels.insights')} icon={Lightbulb} bodyClassName="p-0">
          {data.insights.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noSignals')}</p>
          ) : (
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              {data.insights.map((ins, i) => {
                const I = INSIGHT_ICON[ins.type]
                return (
                  <li key={i} className="flex items-start gap-2.5 px-4 py-2.5">
                    <I.icon size={15} className={cn('mt-0.5 shrink-0', I.cls)} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{ins.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{ins.message}</p>
                      {ins.action ? <p className="mt-0.5 text-xs text-teal-600 dark:text-teal-400">→ {ins.action}</p> : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- Health Scores */
type GroupBy = 'none' | 'segment' | 'tier' | 'churn' | 'grade'
const HEALTH_PAGE = 25

function HealthTab({ data, onDrill }: { data: CustomerData; onDrill: (r: CustomerRow) => void }) {
  const t = useTranslations('analytics.customer')
  const today = useBusinessToday()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [page, setPage] = useState(1)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const rows = data.rows // already health-desc

  const groups = useMemo(() => {
    if (groupBy === 'none') return null
    const keyOf = (r: CustomerRow) =>
      groupBy === 'segment' ? t(`segment.${r.segment}`) : groupBy === 'tier' ? t(`tier.${r.tier}`) : groupBy === 'churn' ? t(`risk.${r.churnLevel}`) : (r.healthGrade ?? '—')
    const map = new Map<string, CustomerRow[]>()
    for (const r of rows) {
      const key = keyOf(r)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return [...map.entries()]
  }, [rows, groupBy, t])

  const totalPages = Math.max(1, Math.ceil(rows.length / HEALTH_PAGE))
  const pageNo = Math.min(page, totalPages)
  const flat = rows.slice((pageNo - 1) * HEALTH_PAGE, pageNo * HEALTH_PAGE)

  // Health bands follow the configured grade ladder: excellent starts at A,
  // critical below D, warning in between.
  const excellentAt = data.config.gradeA
  const warningAt = data.config.gradeD
  const warningBelow = data.config.gradeC
  // Unscored customers sit outside the bands: no score is not the lowest score.
  const scored = rows.filter((r): r is CustomerRow & { healthScore: number } => r.healthScore !== null)
  const excellent = scored.filter((r) => r.healthScore >= excellentAt).length
  const warning = scored.filter((r) => r.healthScore < warningBelow && r.healthScore >= warningAt).length
  const critical = scored.filter((r) => r.healthScore < warningAt).length
  const avgHealth = scored.length ? Math.round(scored.reduce((a, r) => a + r.healthScore, 0) / scored.length) : null
  const noPaymentCount = rows.filter((r) => r.scoredWithoutPayment).length

  const Row = ({ r }: { r: CustomerRow }) => (
    <InteractiveTableRow onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
      <SharedTableCell className="px-4 py-2">
        <p className="font-medium text-slate-800 dark:text-slate-200">{r.name}{r.isFakeChampion ? <span title={t('fakeChampionTitle')}> ⚠️</span> : null}</p>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">{t('lastActive', { days: r.recencyDays === null ? '—' : t('daysAgo', { days: r.recencyDays }) })}</p>
      </SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-center">
        {r.healthGrade === null ? (
          <span className="mr-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-400 dark:bg-slate-800 dark:text-slate-500">—</span>
        ) : (
          <span className={cn('mr-1.5 rounded-full px-2 py-0.5 text-xs font-bold', GRADE_STYLE[r.healthGrade])}>{r.healthGrade}</span>
        )}
        <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">{r.healthScore === null ? '—' : r.healthScore}</span>
      </SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(r.invoicedRevenue)}</SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-teal-600 dark:text-teal-400">{money(r.clv)}</SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEGMENT_STYLE[r.segment])}>{t(`segment.${r.segment}`)}</span></SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.churnLevel])}>{t(`risk.${r.churnLevel}`)}</span></SharedTableCell>
      <SharedTableCell className="px-4 py-2 text-center text-xs text-slate-500 capitalize dark:text-slate-400">{t(`rating.${r.paymentRating}`)}</SharedTableCell>
      <SharedTableCell className="px-4 py-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', REC_STYLE[r.recommendation])} title={r.recommendationDetail}>{t(`rec.${r.recommendation}`)}</span>
      </SharedTableCell>
    </InteractiveTableRow>
  )

  const header = (
    <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
      <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.customer')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.health')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.invoiced')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.projectedClv')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.segment')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.churn')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.payment')}</SharedTableHead>
      <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.recommendation')}</SharedTableHead>
    </SharedTableRow>
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={HeartPulse} accent="teal" label={t('kpi.avgHealth')} value={avgHealth === null ? '—' : String(avgHealth)} sub={t('sub.weightedRfm')} />
        <KpiCard icon={CheckCircle2} accent="emerald" label={t('kpi.excellent')} value={String(excellent)} sub={t('sub.scoreHigh', { cutoff: excellentAt })} tone="positive" />
        <KpiCard icon={AlertTriangle} accent={warning > 0 ? 'amber' : 'emerald'} label={t('kpi.warning')} value={String(warning)} sub={t('sub.scoreMid', { low: warningAt, high: warningBelow - 1 })} />
        <KpiCard icon={AlertOctagon} accent={critical > 0 ? 'red' : 'emerald'} label={t('kpi.critical')} value={String(critical)} sub={t('sub.scoreLow', { cutoff: warningAt })} tone={critical > 0 ? 'negative' : 'positive'} />
      </div>
      {noPaymentCount > 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {t('panels.healthNoPaymentNote', { count: noPaymentCount })}
        </p>
      ) : null}

      <Panel
        title={t('panels.customerHealth', { count: rows.length })}
        icon={HeartPulse}
        hint={t('panels.customerHealthHint', { recency: data.config.healthWeightRecency, frequency: data.config.healthWeightFrequency, monetary: data.config.healthWeightMonetary, payment: data.config.healthWeightPayment })}
        bodyClassName="p-0"
        actions={
          <span className="flex items-center gap-2">
            <Select value={groupBy} onChange={(e) => { setGroupBy(e.target.value as GroupBy); setPage(1) }} className="w-40" triggerClassName="h-7 text-xs">
              <option value="none">{t('groupBy.none')}</option>
              <option value="segment">{t('groupBy.segment')}</option>
              <option value="tier">{t('groupBy.tier')}</option>
              <option value="churn">{t('groupBy.churn')}</option>
              <option value="grade">{t('groupBy.grade')}</option>
            </Select>
            <button
              type="button"
              onClick={() => exportCsv('customer-health', [t('table.customer'), t('table.health'), t('csv.grade'), t('table.revenue'), t('table.invoiced'), t('csv.projectedClv'), t('csv.segment'), t('csv.churn'), t('csv.payment'), t('csv.recommendation')], rows.map((r) => [r.name, r.healthScore ?? '', r.healthGrade ?? '', r.revenue, r.invoicedRevenue, r.clv, t(`segment.${r.segment}`), t(`risk.${r.churnLevel}`), t(`rating.${r.paymentRating}`), t(`rec.${r.recommendation}`)]), today)}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <Download size={11} /> CSV
            </button>
          </span>
        }
      >
        <div className="overflow-x-auto">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>{header}</SharedTableHeader>
            <SharedTableBody>
              {groups
                ? groups.map(([label, set]) => {
                    const isCollapsed = collapsed.has(label)
                    const rev = sum(set.map((r) => r.revenue))
                    return (
                      <GroupRows key={label}>
                        <InteractiveTableRow
                          className="cursor-pointer border-b border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/40"
                          onClick={() => setCollapsed((prev) => { const next = new Set(prev); if (next.has(label)) next.delete(label); else next.add(label); return next })} noAnimate
                        >
                          <SharedTableCell colSpan={9} className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                            <span className="mr-1.5 inline-block align-middle text-slate-400">{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
                            {label}
                            <span className="ml-2 font-normal text-slate-400">{t('groupSummary', { count: set.length, revenue: money(rev) })}</span>
                          </SharedTableCell>
                        </InteractiveTableRow>
                        {!isCollapsed && set.map((r) => <Row key={r.id} r={r} />)}
                      </GroupRows>
                    )
                  })
                : flat.map((r) => <Row key={r.id} r={r} />)}
            </SharedTableBody>
          </SharedTable>
        </div>
        {!groups && totalPages > 1 && (
          <Pager page={pageNo} totalPages={totalPages} total={rows.length} pageSize={HEALTH_PAGE} onPage={setPage} noun={t('pager.nounCustomers')} />
        )}
      </Panel>
    </div>
  )
}

function GroupRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

/** Sortable profitability-table header (module scope: defining it inside
 *  ProfitabilityTab remounts every header — and drops button focus — on each render). */
function ProfitSortTh({
  label,
  col,
  align = 'right',
  sortCol,
  sortDir,
  onToggle,
}: {
  label: string
  col: ProfitSort
  align?: 'left' | 'right'
  sortCol: ProfitSort
  sortDir: 'asc' | 'desc'
  onToggle: (col: ProfitSort) => void
}) {
  return (
    <SharedTableHead className={cn('px-3 py-2 font-medium', align === 'right' ? 'text-right' : 'text-left')}>
      <button type="button" onClick={() => onToggle(col)} className={cn('inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300', sortCol === col && 'text-teal-600 dark:text-teal-400')}>
        {label}
        {sortCol === col && <span className="text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </SharedTableHead>
  )
}

function Pager({ page, totalPages, total, pageSize, onPage, noun }: { page: number; totalPages: number; total: number; pageSize: number; onPage: (p: number) => void; noun: string }) {
  const t = useTranslations('analytics.customer')
  const start = (page - 1) * pageSize
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <span>{t('pager.showing', { from: start + 1, to: Math.min(start + pageSize, total), total })} {noun}</span>
      <div className="flex items-center gap-1">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">{t('pager.prev')}</button>
        <span className="px-2 tabular-nums">{page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">{t('pager.next')}</button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- Segmentation */
function SegmentationTab({ data }: { data: CustomerData }) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const [segment, setSegment] = useState<Segment | 'all'>('all')
  const [page, setPage] = useState(1)
  const totalRevenue = cmp(data.kpis.totalRevenue, "0") === 0 ? "1" : data.kpis.totalRevenue

  const filtered = segment === 'all' ? data.rows : data.rows.filter((r) => r.segment === segment)
  const bySegRevenue = [...filtered].sort((a, b) => cmp(b.revenue, a.revenue))
  const totalPages = Math.max(1, Math.ceil(bySegRevenue.length / 25))
  const pageNo = Math.min(page, totalPages)
  const pageRows = bySegRevenue.slice((pageNo - 1) * 25, pageNo * 25)

  return (
    <div className="space-y-5">
      {/* RFM Matrix grid — the segment cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {data.segments.map((s) => (
          <button
            key={s.segment}
            type="button"
            onClick={() => { setSegment(segment === s.segment ? 'all' : s.segment); setPage(1) }}
            className={cn(
              'rounded-xl border p-3 text-left shadow-sm transition-colors',
              segment === s.segment ? 'border-teal-400 bg-teal-50/60 dark:border-teal-600 dark:bg-teal-950/30' : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700',
            )}
            title={t(`segmentDesc.${s.segment}`)}
          >
            <span className={cn('inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold', SEGMENT_STYLE[s.segment])}>{t(`segment.${s.segment}`)}</span>
            <p className="mt-1.5 text-xl font-semibold text-slate-800 tabular-nums dark:text-slate-100">{s.count}</p>
            <p className="text-[11px] text-slate-400 tabular-nums dark:text-slate-500">{s.percentage}% · {money(s.totalRevenue)}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.segmentPerformance')} icon={Grid3x3} bodyClassName="p-0">
            <SharedTable className="w-full text-sm">
              <SharedTableHeader>
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.segment')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.customers')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.avgPerCustomer')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revShare')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {data.segments.map((s) => (
                  <SharedTableRow key={s.segment} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <SharedTableCell className="px-4 py-2.5">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', SEGMENT_STYLE[s.segment])}>{t(`segment.${s.segment}`)}</span>
                      <span className="ml-2 hidden text-[11px] text-slate-400 lg:inline dark:text-slate-500">{t(`segmentDesc.${s.segment}`)}</span>
                    </SharedTableCell>
                    <SharedTableCell className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{s.count}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(s.totalRevenue)}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{s.count ? money(s.avgRevenue) : '—'}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(ratioNumber(s.totalRevenue, totalRevenue, 0))}</SharedTableCell>
                  </SharedTableRow>
                ))}
              </SharedTableBody>
            </SharedTable>
          </Panel>
        </div>
        <Panel title={t('panels.segmentMix')} icon={PieIcon}>
          <Donut
            data={data.segments.filter((s) => s.count > 0).map((s) => ({ name: t(`segment.${s.segment}`), value: s.count }))}
            colors={data.segments.filter((s) => s.count > 0).map((s) => SEGMENT_COLOR[s.segment])}
            valueFormat={(v) => t('customersCount', { count: Math.round(v) })}
            height={220}
          />
        </Panel>
      </div>

      <Panel
        title={segment === 'all' ? t('panels.customersBySegment', { count: filtered.length }) : t('panels.segmentCustomers', { segment: t(`segment.${segment}`), count: filtered.length })}
        icon={Users}
        hint={t('panels.rfmHint', { good: data.config.recencyGoodDays, warning: data.config.recencyWarningDays, critical: data.config.recencyCriticalDays })}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.customer')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.r')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.f')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.m')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.segment')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.invoices')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.recency')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {pageRows.map((r) => (
                <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><ScoreChip v={r.rfm.r} /></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><ScoreChip v={r.rfm.f} /></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><ScoreChip v={r.rfm.m} /></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEGMENT_STYLE[r.segment])}>{t(`segment.${r.segment}`)}</span></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.invoices}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays === null ? '—' : t('sub.daysShort', { days: r.recencyDays })}</SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </div>
        {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={filtered.length} pageSize={25} onPage={setPage} noun={t('pager.nounCustomers')} />}
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------- Lifetime Value */
function LifetimeTab({
  data,
  profitability,
  projectsEnabled,
}: {
  data: CustomerData
  profitability: Profitability | null
  projectsEnabled: boolean
}) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const [page, setPage] = useState(1)
  const k = data.kpis
  const bands: MarginBands = { high: data.config.profitHighMargin, medium: data.config.profitMediumMargin, low: data.config.profitLowMargin }
  const byClv = [...data.rows].sort((a, b) => cmp(b.clv, a.clv))
  const totalPages = Math.max(1, Math.ceil(byClv.length / 25))
  const pageNo = Math.min(page, totalPages)
  const pageRows = byClv.slice((pageNo - 1) * 25, pageNo * 25)
  const maxTier = Math.max(1, ...data.tierBreakdown.map((tb) => tb.count))

  return (
    <div className="space-y-5">
      <div className={projectsEnabled ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'grid grid-cols-2 gap-3'}>
        <KpiCard icon={Gem} accent="violet" label={t('kpi.totalProjectedClv')} value={money(k.projectedClv)} sub={t('sub.avgPerCustomer', { amount: money(k.avgClv) })} />
        <KpiCard icon={DollarSign} accent="emerald" label={t('kpi.periodRevenue')} value={money(k.totalRevenue)} sub={t('sub.clvBase')} />
        <KpiCard icon={FileText} accent="sky" label={t('kpi.totalInvoiced')} value={money(k.totalInvoiced)} sub={t('sub.invoiced')} />
        {projectsEnabled && profitability ? (
          <>
            <KpiCard icon={HandCoins} accent={cmp(profitability.summary.totalGrossProfit, '0') < 0 ? 'red' : 'sky'} label={t('kpi.grossProfit')} value={fmtMoney(profitability.summary.totalGrossProfit, { compact: true })} sub={profitability.summary.avgMarginPct === null ? t('margin.noRevenue') : t('sub.marginPct', { pct: profitability.summary.avgMarginPct.toFixed(1) })} />
            <KpiCard icon={AlertTriangle} accent={k.fakeChampions === null ? 'sky' : k.fakeChampions > 0 ? 'amber' : 'emerald'} label={t('kpi.profitLeaks')} value={k.fakeChampions === null ? '—' : String(k.fakeChampions)} sub={t('sub.highRevenueLowMargin', { share: data.config.profitLeakRevenueSharePct, margin: data.config.profitLeakMarginTarget })} tone={k.fakeChampions === null ? undefined : k.fakeChampions > 0 ? 'negative' : 'positive'} />
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.tierDistribution')} icon={Layers} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.tierBreakdown.map((tb) => (
              <li key={tb.tier} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn('w-20 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold', TIER_STYLE[tb.tier])}>{t(`tier.${tb.tier}`)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded-full" style={{ width: `${(tb.count / maxTier) * 100}%`, backgroundColor: TIER_COLOR[tb.tier] }} />
                </div>
                <span className="w-24 text-right text-xs text-slate-500 tabular-nums dark:text-slate-400">{tb.count} · {money(tb.revenue)}</span>
                <span className="w-20 text-right text-[11px] text-slate-400 tabular-nums dark:text-slate-500">{cmp(tb.threshold, "0") > 0 ? `≥ ${money(tb.threshold)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('panels.howClvProjected')} icon={Info}>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-300">{t('clvHow.annualBold')}</span>{t('clvHow.annualTail', { floorMonths: data.config.clvMinYears * 12 })}{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">{t('clvHow.retentionBold')}</span>{t('clvHow.retentionHead', { base: data.config.clvRetentionBase / 100 })}<sup>{t('clvHow.retentionSup', { decay: data.config.clvRetentionDecayDays })}</sup>{t('clvHow.retentionTail', { min: data.config.clvRetentionMinPct, max: data.config.clvRetentionMaxPct })}{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">{t('clvHow.clvBold')}</span>{t('clvHow.clvTail', { years: data.config.clvYears })}
            {t('clvHow.tiersNote', tierBands(data.config))}
          </p>
          <div className="mt-3">
            <GroupedBar
              labels={data.tierBreakdown.map((tb) => t(`tier.${tb.tier}`))}
              height={180}
              series={[{ name: t('chart.projectedClv'), data: data.tierBreakdown.map((tb) => toChartNumber(sum(data.rows.filter((r) => r.tier === tb.tier).map((r) => r.clv)))), color: '#0d9488' }]}
            />
          </div>
        </Panel>
      </div>

      <Panel title={t('panels.clvRanking')} icon={Gem} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">#</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.customer')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.tier')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.margin')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.annualValue')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.projectedClv')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.retention')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {pageRows.map((r) => (
                <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <SharedTableCell className="px-4 py-2 text-slate-400 tabular-nums dark:text-slate-500">{r.clvRank}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}{r.isFakeChampion ? <span title={t('fakeChampionTitleShort')}> ⚠️</span> : null}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', TIER_STYLE[r.tier])}>{t(`tier.${r.tier}`)}</span></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.revenue)}</SharedTableCell>
                  <SharedTableCell className={cn('px-4 py-2 text-right tabular-nums', marginClass(r.marginPct, bands))}>{r.marginPct === null ? (r.grossProfit === null ? '—' : t('margin.noRevenue')) : `${r.marginPct.toFixed(1)}%`}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.annualValue)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right font-semibold tabular-nums text-teal-600 dark:text-teal-400">{money(r.clv)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right"><RetentionBadge v={r.retentionFactor} bands={{ good: data.config.gradeB, fair: data.config.gradeD }} /></SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </div>
        {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={byClv.length} pageSize={25} onPage={setPage} noun={t('pager.nounCustomers')} />}
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------------- Churn */
function ChurnTab({ data }: { data: CustomerData }) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const [page, setPage] = useState(1)
  const k = data.kpis
  // List critical, high, and medium risk customers in the at-risk table.
  const atRisk = data.rows.filter((r) => r.churnLevel !== 'low').sort((a, b) => b.churnScore - a.churnScore || cmp(b.revenue, a.revenue))
  const totalPages = Math.max(1, Math.ceil(atRisk.length / 25))
  const pageNo = Math.min(page, totalPages)
  const pageRows = atRisk.slice((pageNo - 1) * 25, pageNo * 25)

  const friction = data.rows.filter((r) => r.frictionPoints > 0).sort((a, b) => b.frictionPoints - a.frictionPoints).slice(0, 10)
  const overdue = data.rows.filter((r) => r.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 10)

  const URGENCY_STYLE: Record<string, string> = {
    critical: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    high: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
    medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    'due-soon': 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
    'on-track': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={AlertOctagon} accent={k.atRiskCount > 0 ? 'red' : 'emerald'} label={t('kpi.recencyRisk')} value={String(k.atRiskCount)} sub={t('sub.highCriticalChurn')} tone={k.atRiskCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Undo2} accent={k.criticalFriction + k.highFriction > 0 ? 'amber' : 'emerald'} label={t('kpi.highFriction')} value={String(k.criticalFriction + k.highFriction)} sub={t('sub.creditHeavy')} />
        <KpiCard icon={CalendarClock} accent={k.overdueOrders > 0 ? 'amber' : 'emerald'} label={t('kpi.overdueOrders')} value={String(k.overdueOrders)} sub={t('sub.pastUsualCycle')} />
        <KpiCard icon={DollarSign} accent={cmp(k.atRiskRevenue, "0") > 0 ? 'red' : 'emerald'} label={t('kpi.atRiskRevenue')} value={money(k.atRiskRevenue)} sub={t('sub.highCriticalAccounts')} tone={cmp(k.atRiskRevenue, "0") > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.frictionSignals')} hint={t('panels.frictionHint')} bodyClassName="p-0">
          {friction.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noFriction')}</p>
          ) : (
            <SharedTable className="w-full text-sm">
              <SharedTableHeader>
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.customer')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.credits')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.creditValue')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.issueRate')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.level')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {friction.map((r) => (
                  <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.creditCount}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{fmtMoney(r.creditValue, { compact: true })}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.returnRate.toFixed(1)}%</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.frictionLevel])}>{t(`risk.${r.frictionLevel}`)}</span></SharedTableCell>
                  </SharedTableRow>
                ))}
              </SharedTableBody>
            </SharedTable>
          )}
        </Panel>

        <Panel title={t('panels.overdueOrders')} hint={t('panels.overdueHint')} bodyClassName="p-0">
          {overdue.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noOverdue')}</p>
          ) : (
            <SharedTable className="w-full text-sm">
              <SharedTableHeader>
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.customer')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.avgCycle')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.overdue')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.urgency')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {overdue.map((r) => (
                  <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{t('sub.daysShort', { days: r.avgOrderCycle })}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right font-semibold tabular-nums text-orange-600 dark:text-orange-400">{t('sub.daysShort', { days: r.daysOverdue })}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', URGENCY_STYLE[r.urgency])}>{t(`urgency.${r.urgency}`)}</span></SharedTableCell>
                  </SharedTableRow>
                ))}
              </SharedTableBody>
            </SharedTable>
          )}
        </Panel>
      </div>

      <Panel
        title={t('panels.atRiskCustomers', { count: atRisk.length })}
        icon={AlertOctagon}
        hint={t('panels.atRiskHint', {
          recMax: data.config.churnInactiveCriticalPoints,
          highDays: data.config.churnHighDays,
          medDays: data.config.churnMediumDays,
          lowDays: data.config.churnInactiveLowDays,
          cadMax: data.config.churnCadenceHighPoints,
          highX: data.config.churnCadenceHighMultiple,
          lowX: data.config.churnCadenceLowMultiple,
          engMax: data.config.churnSinglePoints,
          singleTxns: data.config.churnSingleMaxTxns,
          fewTxns: data.config.churnFewMaxTxns,
        })}
        bodyClassName="p-0"
      >
        {atRisk.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noAtRisk')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader>
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.customer')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.risk')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.score')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.daysInactive')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.retentionProb')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.riskFactors')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {pageRows.map((r) => (
                    <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.churnLevel])}>{t(`risk.${r.churnLevel}`)}</span></SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-200">{r.churnScore}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays === null ? '—' : t('sub.daysShort', { days: r.recencyDays })}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right"><RetentionBadge v={r.retentionProbability} bands={{ good: data.config.gradeB, fair: data.config.gradeD }} /></SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">{r.churnFactors.join(' · ') || '—'}</SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
            {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={atRisk.length} pageSize={25} onPage={setPage} noun={t('pager.nounCustomers')} />}
          </>
        )}
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------------- Growth */
function GrowthTab({ data }: { data: CustomerData }) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const g = data.growth
  const k = data.kpis
  const growthCls = (v: number | null) => (v === null ? 'text-slate-400 dark:text-slate-500' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : v < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard icon={TrendingUp} accent={(g.yoyGrowth ?? 0) >= 0 ? 'emerald' : 'red'} label={t('kpi.yoyGrowth')} value={g.yoyGrowth === null ? '—' : `${g.yoyGrowth >= 0 ? '+' : ''}${g.yoyGrowth}%`} sub={t('sub.last3moVsLy')} tone={(g.yoyGrowth ?? 0) >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={BarChart3} accent={g.avgMonthlyGrowth >= 0 ? 'teal' : 'amber'} label={t('kpi.avgMonthly')} value={`${g.avgMonthlyGrowth >= 0 ? '+' : ''}${g.avgMonthlyGrowth}%`} sub={t('sub.trend', { trend: t(`trend.${g.trend}`) })} />
        <KpiCard icon={DollarSign} accent="sky" label={t('kpi.medianMonthly')} value={money(g.medianMonthlyRevenue)} sub={t('sub.revenue')} />
        <KpiCard icon={Users} accent="violet" label={t('kpi.newCustomers')} value={String(g.totalNewCustomers)} sub={t('sub.firstOrderInPeriod')} />
        <KpiCard icon={HeartPulse} accent={data.cohorts.overallRetention >= data.config.gradeD ? 'emerald' : 'amber'} label={t('kpi.retentionRate')} value={`${data.cohorts.overallRetention}%`} sub={t('sub.activeLastMonths', { months: data.config.cohortActiveMonths })} />
      </div>

      {k.overdueInvoices > data.config.overdueInsightCount ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">{t('overdueBanner.count', { count: k.overdueInvoices })}</span>{t('overdueBanner.rest')}</span>
        </p>
      ) : null}

      <Panel title={t('panels.monthlyRevenueTrend')} icon={BarChart3}>
        <GroupedBar
          labels={g.monthly.map((m) => m.label)}
          height={240}
          series={[{ name: t('table.revenue'), data: g.monthly.map((m) => toChartNumber(m.revenue)), color: '#0d9488' }]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.cohortRetention')} hint={t('panels.cohortHint', { months: data.config.cohortActiveMonths })} bodyClassName="p-0">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.cohort')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.customers')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.active')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.retention')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.avgLifetimeRev')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {data.cohorts.list.map((c) => (
                <SharedTableRow key={c.year} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <SharedTableCell className="px-4 py-2 font-medium text-slate-700 tabular-nums dark:text-slate-300">{c.year}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{c.totalCustomers}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{c.activeCustomers}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right"><RetentionBadge v={c.retentionRate} bands={{ good: data.config.gradeB, fair: data.config.gradeD }} /></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(c.avgRevenue)}</SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </Panel>

        <Panel title={t('panels.monthlyDetails')} hint={t('panels.monthlyDetailsHint', { up: data.config.growthMomCapUp, down: data.config.growthMomCapDown })} bodyClassName="p-0">
          <div className="max-h-80 overflow-y-auto">
            <SharedTable className="w-full text-sm">
              <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.month')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.customers')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.new')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.txns')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.mom')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {g.monthly.map((m) => (
                  <SharedTableRow key={m.month} className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', !m.isMature && 'opacity-60')}>
                    <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{m.label}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(m.revenue)}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{m.uniqueCustomers}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{m.newCustomers}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{m.transactionCount}</SharedTableCell>
                    <SharedTableCell className={cn('px-4 py-2 text-right font-medium tabular-nums', growthCls(m.growthRate))}>
                      {m.growthRate === null ? '—' : `${m.growthRate > 0 ? '+' : ''}${m.growthRate}%`}
                    </SharedTableCell>
                  </SharedTableRow>
                ))}
              </SharedTableBody>
            </SharedTable>
          </div>
        </Panel>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- Profitability */
type ProfitSort = 'customerName' | 'totalRevenue' | 'totalCost' | 'grossProfit' | 'marginPct'
const PAGE_SIZE = 20

function ProfitabilityTab({ p, leak, bands }: { p: Profitability; leak: { share: number; margin: number }; bands: MarginBands }) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: MoneyValue) => fmtMoney(n, { compact: true })
  const marginLabel = (m: number | null, bands: MarginBands): string => {
    if (m === null) return t('margin.noRevenue')
    if (m >= bands.high) return t('margin.excellent')
    if (m >= bands.medium) return t('margin.good')
    if (m >= bands.low) return t('margin.fair')
    if (m >= 0) return t('margin.low')
    return t('margin.loss')
  }
  const s = p.summary
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sortCol, setSortCol] = useState<ProfitSort>('totalRevenue')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const sorted = [...p.customers].sort((a, b) => {
    const av = a[sortCol]
    const bv = b[sortCol]
    if (sortCol === 'totalRevenue' || sortCol === 'totalCost' || sortCol === 'grossProfit') {
      const order = cmp(String(av ?? '0'), String(bv ?? '0'))
      return sortDir === 'asc' ? order : -order
    }
    if (typeof av === 'string' && typeof bv === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageNo = Math.min(page, totalPages)
  const start = (pageNo - 1) * PAGE_SIZE
  const pageCustomers = sorted.slice(start, start + PAGE_SIZE)

  const toggleSort = (col: ProfitSort) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      setSortDir(col === 'customerName' ? 'asc' : 'desc')
    }
  }
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={DollarSign} accent="emerald" label={t('kpi.totalRevenue')} value={money(s.totalRevenue)} sub={t('sub.customersCount', { count: s.customerCount })} />
        <KpiCard icon={FileText} accent="red" label={t('kpi.totalCosts')} value={money(s.totalCost)} sub={t('sub.jobsCount', { count: s.totalJobs })} />
        <KpiCard icon={HandCoins} accent={cmp(s.totalGrossProfit, '0') < 0 ? 'red' : 'sky'} label={t('kpi.grossProfit')} value={money(s.totalGrossProfit)} sub={cmp(s.totalGrossProfit, '0') < 0 ? t('margin.loss') : t('margin.profit')} tone={cmp(s.totalGrossProfit, '0') < 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Percent} accent={marginAccent(s.avgMarginPct, bands)} label={t('kpi.avgMargin')} value={s.avgMarginPct === null ? '—' : `${s.avgMarginPct.toFixed(1)}%`} sub={marginLabel(s.avgMarginPct, bands)} />
      </div>

      {p.customers.length === 0 ? (
        <Panel title={t('panels.customerProfitability')} icon={Users}>
          <p className="py-8 text-center text-sm text-slate-400">{t('empty.noProjectProfitability')}</p>
        </Panel>
      ) : (
        <Panel title={t('panels.customerProfitability')} icon={Users} hint={t('panels.profitabilityHint', { share: leak.share, margin: leak.margin })} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <SharedTable className="w-full text-sm">
              <SharedTableHeader>
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="w-8 px-2 py-2" />
                  <ProfitSortTh label={t('table.customerJob')} col="customerName" align="left" sortCol={sortCol} sortDir={sortDir} onToggle={toggleSort} />
                  <ProfitSortTh label={t('table.revenue')} col="totalRevenue" sortCol={sortCol} sortDir={sortDir} onToggle={toggleSort} />
                  <ProfitSortTh label={t('table.costs')} col="totalCost" sortCol={sortCol} sortDir={sortDir} onToggle={toggleSort} />
                  <ProfitSortTh label={t('table.profit')} col="grossProfit" sortCol={sortCol} sortDir={sortDir} onToggle={toggleSort} />
                  <ProfitSortTh label={t('table.margin')} col="marginPct" sortCol={sortCol} sortDir={sortDir} onToggle={toggleSort} />
                  <SharedTableHead className="px-3 py-2 text-center font-medium">{t('table.tier')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {pageCustomers.map((c) => {
                  const isOpen = expanded.has(c.customerId)
                  return (
                    <GroupRows key={c.customerId}>
                      <InteractiveTableRow
                        className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                        onClick={() => toggle(c.customerId)} noAnimate
                      >
                        <SharedTableCell className="px-2 py-2.5 text-center text-slate-400">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2.5">
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{c.customerName}{c.isFakeChampion ? <span title={t('fakeChampionTitle')}> ⚠️</span> : null}</span>
                          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t('jobsCount', { count: c.jobs.length })}</span>
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{money(c.totalRevenue)}</SharedTableCell>
                        <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{money(c.totalCost)}</SharedTableCell>
                        <SharedTableCell className={cn('px-3 py-2.5 text-right font-medium tabular-nums', cmp(c.grossProfit, '0') < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{money(c.grossProfit)}</SharedTableCell>
                        <SharedTableCell className={cn('px-3 py-2.5 text-right font-bold tabular-nums', marginClass(c.marginPct, bands))}>{c.marginPct === null ? t('margin.noRevenue') : `${c.marginPct.toFixed(1)}%`}</SharedTableCell>
                        <SharedTableCell className="px-3 py-2.5 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', PROFIT_TIER_STYLE[c.profitTier])}>{t(`profitTier.${c.profitTier}`)}</span></SharedTableCell>
                      </InteractiveTableRow>
                      {isOpen
                        ? c.jobs.map((j) => (
                            <SharedTableRow key={j.jobId} className="border-b border-slate-50 bg-slate-50/40 text-xs dark:border-slate-800/60 dark:bg-slate-800/20">
                              <SharedTableCell />
                              <SharedTableCell className="py-2 pr-3 pl-8">
                                <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                                  <FolderGit2 size={12} className="text-slate-400" />
                                  {j.jobName}
                                  {j.transactionCount ? <span className="text-slate-400 dark:text-slate-500">({t('txnsCount', { count: j.transactionCount })})</span> : null}
                                </span>
                              </SharedTableCell>
                              <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(j.revenue)}</SharedTableCell>
                              <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(j.costs)}</SharedTableCell>
                              <SharedTableCell className={cn('px-3 py-2 text-right tabular-nums', cmp(j.profit, '0') < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300')}>{money(j.profit)}</SharedTableCell>
                              <SharedTableCell className={cn('px-3 py-2 text-right tabular-nums', marginClass(j.marginPct, bands))}>{j.marginPct === null ? t('margin.noRevenue') : `${j.marginPct.toFixed(1)}%`}</SharedTableCell>
                              <SharedTableCell />
                            </SharedTableRow>
                          ))
                        : null}
                    </GroupRows>
                  )
                })}
              </SharedTableBody>
            </SharedTable>
          </div>
          {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={sorted.length} pageSize={PAGE_SIZE} onPage={setPage} noun={t('pager.nounCustomers')} />}
        </Panel>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- Configuration */
function ConfigurationTab({ data, canEdit }: { data: CustomerData; canEdit: boolean }) {
  const t = useTranslations('analytics.customer')
  const item = (label: string, value: string) => (
    <div className="flex items-center justify-between border-b border-slate-50 py-2 text-sm last:border-0 dark:border-slate-800/60">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-700 tabular-nums dark:text-slate-300">{value}</span>
    </div>
  )
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ConfigEditor dashboard="customerIntelligence" canEdit={canEdit} />
        <Panel title={t('panels.scoringModel')} hint={t('panels.scoringModelHint')}>
          {item(t('scoring.healthWeights.label'), t('scoring.healthWeights.value', { recency: data.config.healthWeightRecency, frequency: data.config.healthWeightFrequency, monetary: data.config.healthWeightMonetary, payment: data.config.healthWeightPayment }))}
          {item(t('scoring.frictionPenalty.label'), t('scoring.frictionPenalty.value', { critical: data.config.frictionPenaltyCritical, high: data.config.frictionPenaltyHigh, medium: data.config.frictionPenaltyMedium }))}
          {item(t('scoring.rfmRecency.label'), t('scoring.rfmRecency.value', { good: data.config.recencyGoodDays, warning: data.config.recencyWarningDays, critical: data.config.recencyCriticalDays }))}
          {item(t('scoring.rfmFrequency.label'), t('scoring.rfmFrequency.value'))}
          {item(t('scoring.clvRetention.label'), t('scoring.clvRetention.value', { base: data.config.clvRetentionBase / 100, decay: data.config.clvRetentionDecayDays, min: data.config.clvRetentionMinPct, max: data.config.clvRetentionMaxPct }))}
          {item(t('scoring.clvTiers.label'), t('scoring.clvTiers.value', tierBands(data.config)))}
          {item(t('scoring.paymentScore.label'), t('scoring.paymentScore.value', { highPenalty: data.config.paymentDsoHighPenalty, medPenalty: data.config.paymentDsoMediumPenalty, lowPenalty: data.config.paymentDsoLowPenalty, highDays: data.config.paymentDsoHighDays, medDays: data.config.paymentDsoMediumDays, lowDays: data.config.paymentDsoLowDays, cap: data.config.paymentOverdueCap, per: data.config.paymentOverduePerInvoice }))}
          {item(t('scoring.healthGrades.label'), t('scoring.healthGrades.value', { aPlus: data.config.gradeAPlus, a: data.config.gradeA, b: data.config.gradeB, c: data.config.gradeC, d: data.config.gradeD }))}
        </Panel>
      </div>
      <Panel title={t('panels.dataSources')} icon={Timer}>
        <ul className="space-y-2.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.revenueBold')}</span>{t('sources.revenueTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.recencyBold')}</span>{t('sources.recencyTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.frictionBold')}</span>{t('sources.frictionTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.paymentBold')}</span>{t('sources.paymentTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.newCustomersBold')}</span>{t('sources.newCustomersTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.cohortsBold')}</span>{t('sources.cohortsTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.profitabilityBold')}</span>{t('sources.profitabilityTail')}</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.intelligenceBold')}</span> {data.intelligence.score === null ? data.intelligence.reason : t('sources.intelligenceTail', {
            champions: data.config.intelWeightChampions,
            saturation: data.config.tierPlatinumPct * 2,
            retention: data.config.intelWeightRetention,
            concentration: data.config.intelWeightConcentration,
            payment: data.config.intelWeightPayment,
            score: data.intelligence.score,
            grade: data.intelligence.grade,
          })}</li>
        </ul>
      </Panel>
    </div>
  )
}
