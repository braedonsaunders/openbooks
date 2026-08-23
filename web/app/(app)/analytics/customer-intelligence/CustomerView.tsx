'use client'

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
  Trophy,
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
  Settings2,
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
import { useAnalyticsMoney, fmtPct } from '../_ui/format'

const TABS = ['overview', 'health', 'segmentation', 'lifetime', 'churn', 'growth', 'profitability', 'configuration'] as const
type Tab = (typeof TABS)[number]

/* ------------------------------------------------------------ badge styles */
const PROFIT_TIER_STYLE: Record<ProfitTier, string> = {
  high: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  medium: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  low: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  marginal: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  loss: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
function marginClass(m: number): string {
  if (m >= 40) return 'text-emerald-600 dark:text-emerald-400'
  if (m < 0) return 'text-red-600 dark:text-red-400'
  if (m < 10) return 'text-amber-600 dark:text-amber-400'
  return 'text-slate-700 dark:text-slate-300'
}
function marginAccent(m: number): 'emerald' | 'sky' | 'violet' | 'amber' | 'red' {
  if (m >= 40) return 'emerald'
  if (m >= 25) return 'sky'
  if (m >= 10) return 'violet'
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

const SEGMENTS: Segment[] = ['champions', 'loyal', 'potential', 'new', 'regular', 'hibernating', 'at-risk', 'lost']
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

const GRADE_STYLE: Record<CustomerRow['healthGrade'], string> = {
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

function RetentionBadge({ v }: { v: number }) {
  const cls = v >= 70 ? 'text-emerald-600 dark:text-emerald-400' : v >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
  return <span className={cn('font-semibold tabular-nums', cls)}>{v}%</span>
}

/* -------------------------------------------------------------------- view */
export function CustomerView({
  data,
  profitability,
  projectsEnabled = true,
}: {
  data: CustomerData
  profitability: Profitability
  projectsEnabled?: boolean
}) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const tabs = projectsEnabled ? TABS : TABS.filter((key) => key !== 'profitability')
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const k = data.kpis
  const intel = data.intelligence
  const openCustomer = (r: Pick<CustomerRow, 'id' | 'name' | 'invoices' | 'revenue'>) =>
    setDrill({ kind: 'party', id: r.id, name: r.name, sub: t('drill.invoicesRevenue', { invoices: r.invoices, revenue: money(r.revenue) }) })

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={intel.score} label={intel.label} size={132} thickness={12} showTicks={false} />
        </div>
        <KpiCard icon={Users} accent="sky" label={t('kpi.totalCustomers')} value={String(k.totalCustomers)} sub={t('sub.newInPeriod', { count: k.newCustomers })} />
        <KpiCard icon={Crown} accent="violet" label={t('kpi.champions')} value={String(k.champions)} sub={t('sub.rfmChampions')} />
        <KpiCard icon={Gem} accent="amber" label={t('kpi.projectedClv')} value={money(k.projectedClv)} sub={t('sub.threeYearProjection')} />
        <KpiCard icon={AlertOctagon} accent={k.atRiskCount > 0 ? 'red' : 'emerald'} label={t('kpi.atRisk')} value={String(k.atRiskCount)} sub={money(k.atRiskRevenue)} tone={k.atRiskCount > 0 ? 'negative' : 'positive'} />
      </div>

      {/* Tabs */}
      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors',
                tab === key ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'health' ? <HealthTab data={data} onDrill={openCustomer} /> : null}
        {tab === 'segmentation' ? <SegmentationTab data={data} /> : null}
        {tab === 'lifetime' ? <LifetimeTab data={data} profitability={profitability} projectsEnabled={projectsEnabled} /> : null}
        {tab === 'churn' ? <ChurnTab data={data} /> : null}
        {tab === 'growth' ? <GrowthTab data={data} /> : null}
        {tab === 'profitability' && projectsEnabled ? <ProfitabilityTab p={profitability} /> : null}
        {tab === 'configuration' ? <ConfigurationTab data={data} /> : null}
      </div>

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
  const money = (n: number) => fmtMoney(n, { compact: true })
  const k = data.kpis
  const top = [...data.rows].sort((a, b) => b.revenue - a.revenue).slice(0, 10)
  const maxSegRevenue = Math.max(1, ...data.segments.map((s) => s.totalRevenue))

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
          {metric(t('metrics.retention'), `${k.retentionRate}%`, t('metricsSub.retentionProb'))}
          {metric(t('metrics.paymentRate'), `${k.paymentRate}%`, t('metricsSub.paidInFull'))}
          {metric(t('metrics.avgDso'), `${k.avgDaysToPay}d`, t('metricsSub.daysToPay'))}
          {metric(t('metrics.top10Share'), `${k.top10PctShare}%`, t('metricsSub.ofRevenue'))}
          {metric(t('metrics.monthlyGrowth'), `${k.monthlyGrowth >= 0 ? '+' : ''}${k.monthlyGrowth}%`, t('metricsSub.avgMoM'))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.topByRevenue')} icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => r.revenue)} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title={t('panels.revenueByTier')} icon={PieIcon}>
          <Donut
            data={data.tierBreakdown.filter((x) => x.revenue > 0).map((x) => ({ name: t(`tier.${x.tier}`), value: x.revenue }))}
            colors={data.tierBreakdown.filter((x) => x.revenue > 0).map((x) => TIER_COLOR[x.tier])}
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
                  <div className="h-full rounded-full" style={{ width: `${(s.totalRevenue / maxSegRevenue) * 100}%`, backgroundColor: SEGMENT_COLOR[s.segment] }} />
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
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [page, setPage] = useState(1)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const rows = data.rows // already health-desc

  const groups = useMemo(() => {
    if (groupBy === 'none') return null
    const keyOf = (r: CustomerRow) =>
      groupBy === 'segment' ? t(`segment.${r.segment}`) : groupBy === 'tier' ? t(`tier.${r.tier}`) : groupBy === 'churn' ? t(`risk.${r.churnLevel}`) : r.healthGrade
    const map = new Map<string, CustomerRow[]>()
    for (const r of rows) {
      const key = keyOf(r)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return [...map.entries()]
  }, [rows, groupBy])

  const totalPages = Math.max(1, Math.ceil(rows.length / HEALTH_PAGE))
  const pageNo = Math.min(page, totalPages)
  const flat = rows.slice((pageNo - 1) * HEALTH_PAGE, pageNo * HEALTH_PAGE)

  const excellent = rows.filter((r) => r.healthScore >= 80).length
  const warning = rows.filter((r) => r.healthScore < 60 && r.healthScore >= 40).length
  const critical = rows.filter((r) => r.healthScore < 40).length
  const avgHealth = rows.length ? Math.round(rows.reduce((a, r) => a + r.healthScore, 0) / rows.length) : 0

  const Row = ({ r }: { r: CustomerRow }) => (
    <tr onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
      <td className="px-4 py-2">
        <p className="font-medium text-slate-800 dark:text-slate-200">{r.name}{r.isFakeChampion ? <span title={t('fakeChampionTitle')}> ⚠️</span> : null}</p>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">{t('lastActive', { days: r.recencyDays >= 9999 ? '—' : t('daysAgo', { days: r.recencyDays }) })}</p>
      </td>
      <td className="px-4 py-2 text-center">
        <span className={cn('mr-1.5 rounded-full px-2 py-0.5 text-xs font-bold', GRADE_STYLE[r.healthGrade])}>{r.healthGrade}</span>
        <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">{r.healthScore}</span>
      </td>
      <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-teal-600 dark:text-teal-400">{money(r.clv)}</td>
      <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEGMENT_STYLE[r.segment])}>{t(`segment.${r.segment}`)}</span></td>
      <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.churnLevel])}>{t(`risk.${r.churnLevel}`)}</span></td>
      <td className="px-4 py-2 text-center text-xs text-slate-500 capitalize dark:text-slate-400">{r.paymentRating}</td>
      <td className="px-4 py-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', REC_STYLE[r.recommendation])} title={r.recommendationDetail}>{t(`rec.${r.recommendation}`)}</span>
      </td>
    </tr>
  )

  const header = (
    <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
      <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
      <th className="px-4 py-2 text-center font-medium">{t('table.health')}</th>
      <th className="px-4 py-2 text-right font-medium">{t('table.revenue')}</th>
      <th className="px-4 py-2 text-right font-medium">{t('table.projectedClv')}</th>
      <th className="px-4 py-2 text-center font-medium">{t('table.segment')}</th>
      <th className="px-4 py-2 text-center font-medium">{t('table.churn')}</th>
      <th className="px-4 py-2 text-center font-medium">{t('table.payment')}</th>
      <th className="px-4 py-2 text-left font-medium">{t('table.recommendation')}</th>
    </tr>
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={HeartPulse} accent="teal" label={t('kpi.avgHealth')} value={String(avgHealth)} sub={t('sub.weightedRfm')} />
        <KpiCard icon={CheckCircle2} accent="emerald" label={t('kpi.excellent')} value={String(excellent)} sub={t('sub.score80Plus')} tone="positive" />
        <KpiCard icon={AlertTriangle} accent={warning > 0 ? 'amber' : 'emerald'} label={t('kpi.warning')} value={String(warning)} sub={t('sub.score40to59')} />
        <KpiCard icon={AlertOctagon} accent={critical > 0 ? 'red' : 'emerald'} label={t('kpi.critical')} value={String(critical)} sub={t('sub.scoreBelow40')} tone={critical > 0 ? 'negative' : 'positive'} />
      </div>

      <Panel
        title={t('panels.customerHealth', { count: rows.length })}
        icon={HeartPulse}
        hint={t('panels.customerHealthHint')}
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
              onClick={() => exportCsv('customer-health', [t('table.customer'), t('table.health'), t('csv.grade'), t('table.revenue'), t('csv.projectedClv'), t('csv.segment'), t('csv.churn'), t('csv.payment'), t('csv.recommendation')], rows.map((r) => [r.name, r.healthScore, r.healthGrade, Math.round(r.revenue), Math.round(r.clv), t(`segment.${r.segment}`), t(`risk.${r.churnLevel}`), r.paymentRating, t(`rec.${r.recommendation}`)]), today)}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <Download size={11} /> CSV
            </button>
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>{header}</thead>
            <tbody>
              {groups
                ? groups.map(([label, set]) => {
                    const isCollapsed = collapsed.has(label)
                    const rev = set.reduce((a, r) => a + r.revenue, 0)
                    return (
                      <GroupRows key={label}>
                        <tr
                          className="cursor-pointer border-b border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/40"
                          onClick={() => setCollapsed((prev) => { const next = new Set(prev); next.has(label) ? next.delete(label) : next.add(label); return next })}
                        >
                          <td colSpan={8} className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                            <span className="mr-1.5 inline-block align-middle text-slate-400">{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
                            {label}
                            <span className="ml-2 font-normal text-slate-400">{t('groupSummary', { count: set.length, revenue: money(rev) })}</span>
                          </td>
                        </tr>
                        {!isCollapsed && set.map((r) => <Row key={r.id} r={r} />)}
                      </GroupRows>
                    )
                  })
                : flat.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          </table>
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
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [segment, setSegment] = useState<Segment | 'all'>('all')
  const [page, setPage] = useState(1)
  const totalRevenue = data.kpis.totalRevenue || 1

  const filtered = segment === 'all' ? data.rows : data.rows.filter((r) => r.segment === segment)
  const bySegRevenue = [...filtered].sort((a, b) => b.revenue - a.revenue)
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.segment')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.customers')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.revenue')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.avgPerCustomer')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.revShare')}</th>
                </tr>
              </thead>
              <tbody>
                {data.segments.map((s) => (
                  <tr key={s.segment} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', SEGMENT_STYLE[s.segment])}>{t(`segment.${s.segment}`)}</span>
                      <span className="ml-2 hidden text-[11px] text-slate-400 lg:inline dark:text-slate-500">{t(`segmentDesc.${s.segment}`)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{s.count}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(s.totalRevenue)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{s.count ? money(s.avgRevenue) : '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(s.totalRevenue / totalRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
        hint={t('panels.rfmHint')}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.r')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.f')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.m')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.segment')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.revenue')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.invoices')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.recency')}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                  <td className="px-4 py-2 text-center"><ScoreChip v={r.rfm.r} /></td>
                  <td className="px-4 py-2 text-center"><ScoreChip v={r.rfm.f} /></td>
                  <td className="px-4 py-2 text-center"><ScoreChip v={r.rfm.m} /></td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEGMENT_STYLE[r.segment])}>{t(`segment.${r.segment}`)}</span></td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.invoices}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays >= 9999 ? '—' : `${r.recencyDays}d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  profitability: Profitability
  projectsEnabled: boolean
}) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [page, setPage] = useState(1)
  const k = data.kpis
  const byClv = [...data.rows].sort((a, b) => b.clv - a.clv)
  const totalPages = Math.max(1, Math.ceil(byClv.length / 25))
  const pageNo = Math.min(page, totalPages)
  const pageRows = byClv.slice((pageNo - 1) * 25, pageNo * 25)
  const maxTier = Math.max(1, ...data.tierBreakdown.map((tb) => tb.count))

  return (
    <div className="space-y-5">
      <div className={projectsEnabled ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'grid grid-cols-2 gap-3'}>
        <KpiCard icon={Gem} accent="violet" label={t('kpi.totalProjectedClv')} value={money(k.projectedClv)} sub={t('sub.avgPerCustomer', { amount: money(k.avgClv) })} />
        <KpiCard icon={DollarSign} accent="emerald" label={t('kpi.periodRevenue')} value={money(k.totalRevenue)} sub={t('sub.clvBase')} />
        {projectsEnabled ? (
          <>
            <KpiCard icon={HandCoins} accent={profitability.summary.totalGrossProfit < 0 ? 'red' : 'sky'} label={t('kpi.grossProfit')} value={money(profitability.summary.totalGrossProfit)} sub={t('sub.marginPct', { pct: profitability.summary.avgMarginPct.toFixed(1) })} />
            <KpiCard icon={AlertTriangle} accent={k.fakeChampions > 0 ? 'amber' : 'emerald'} label={t('kpi.profitLeaks')} value={String(k.fakeChampions)} sub={t('sub.highRevenueLowMargin')} tone={k.fakeChampions > 0 ? 'negative' : 'positive'} />
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
                <span className="w-20 text-right text-[11px] text-slate-400 tabular-nums dark:text-slate-500">{tb.threshold > 0 ? `≥ ${money(tb.threshold)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('panels.howClvProjected')} icon={Info}>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-300">{t('clvHow.annualBold')}</span>{t('clvHow.annualTail')}{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">{t('clvHow.retentionBold')}</span>{t('clvHow.retentionHead')}<sup>{t('clvHow.retentionSup')}</sup>{t('clvHow.retentionTail')}{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">{t('clvHow.clvBold')}</span>{t('clvHow.clvTail')}
            {t('clvHow.tiersNote')}
          </p>
          <div className="mt-3">
            <GroupedBar
              labels={data.tierBreakdown.map((tb) => t(`tier.${tb.tier}`))}
              height={180}
              series={[{ name: t('chart.projectedClv'), data: data.tierBreakdown.map((tb) => data.rows.filter((r) => r.tier === tb.tier).reduce((a, r) => a + r.clv, 0)), color: '#0d9488' }]}
            />
          </div>
        </Panel>
      </div>

      <Panel title={t('panels.clvRanking')} icon={Gem} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">#</th>
                <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.tier')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.revenue')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.margin')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.annualValue')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.projectedClv')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.retention')}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-400 tabular-nums dark:text-slate-500">{r.clvRank}</td>
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}{r.isFakeChampion ? <span title={t('fakeChampionTitleShort')}> ⚠️</span> : null}</td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', TIER_STYLE[r.tier])}>{t(`tier.${r.tier}`)}</span></td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.revenue)}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', r.marginPct === null ? 'text-slate-400 dark:text-slate-500' : marginClass(r.marginPct))}>{r.marginPct === null ? '—' : `${r.marginPct.toFixed(1)}%`}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.annualValue)}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-teal-600 dark:text-teal-400">{money(r.clv)}</td>
                  <td className="px-4 py-2 text-right"><RetentionBadge v={r.retentionFactor} /></td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [page, setPage] = useState(1)
  const k = data.kpis
  // List critical, high, and medium risk customers in the at-risk table.
  const atRisk = data.rows.filter((r) => r.churnLevel !== 'low').sort((a, b) => b.churnScore - a.churnScore || b.revenue - a.revenue)
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
        <KpiCard icon={DollarSign} accent={k.atRiskRevenue > 0 ? 'red' : 'emerald'} label={t('kpi.atRiskRevenue')} value={money(k.atRiskRevenue)} sub={t('sub.highCriticalAccounts')} tone={k.atRiskRevenue > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.frictionSignals')} hint={t('panels.frictionHint')} bodyClassName="p-0">
          {friction.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noFriction')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.credits')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.creditValue')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.issueRate')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('table.level')}</th>
                </tr>
              </thead>
              <tbody>
                {friction.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.creditCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{money(r.creditValue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.returnRate.toFixed(1)}%</td>
                    <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.frictionLevel])}>{t(`risk.${r.frictionLevel}`)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={t('panels.overdueOrders')} hint={t('panels.overdueHint')} bodyClassName="p-0">
          {overdue.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noOverdue')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.avgCycle')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.overdue')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('table.urgency')}</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.avgOrderCycle}d</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums text-orange-600 dark:text-orange-400">{r.daysOverdue}d</td>
                    <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', URGENCY_STYLE[r.urgency])}>{r.urgency}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel
        title={t('panels.atRiskCustomers', { count: atRisk.length })}
        icon={AlertOctagon}
        hint={t('panels.atRiskHint')}
        bodyClassName="p-0"
      >
        {atRisk.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-slate-400">{t('empty.noAtRisk')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('table.risk')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.score')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.daysInactive')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.revenue')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.retentionProb')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.riskFactors')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                      <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.churnLevel])}>{t(`risk.${r.churnLevel}`)}</span></td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-200">{r.churnScore}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays >= 9999 ? '—' : `${r.recencyDays}d`}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</td>
                      <td className="px-4 py-2 text-right"><RetentionBadge v={r.retentionProbability} /></td>
                      <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">{r.churnFactors.join(' · ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
  const money = (n: number) => fmtMoney(n, { compact: true })
  const g = data.growth
  const k = data.kpis
  const growthCls = (v: number | null) => (v === null ? 'text-slate-400 dark:text-slate-500' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : v < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard icon={TrendingUp} accent={(g.yoyGrowth ?? 0) >= 0 ? 'emerald' : 'red'} label={t('kpi.yoyGrowth')} value={g.yoyGrowth === null ? '—' : `${g.yoyGrowth >= 0 ? '+' : ''}${g.yoyGrowth}%`} sub={t('sub.last3moVsLy')} tone={(g.yoyGrowth ?? 0) >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={BarChart3} accent={g.avgMonthlyGrowth >= 0 ? 'teal' : 'amber'} label={t('kpi.avgMonthly')} value={`${g.avgMonthlyGrowth >= 0 ? '+' : ''}${g.avgMonthlyGrowth}%`} sub={t('sub.trend', { trend: g.trend })} />
        <KpiCard icon={DollarSign} accent="sky" label={t('kpi.medianMonthly')} value={money(g.medianMonthlyRevenue)} sub={t('sub.revenue')} />
        <KpiCard icon={Users} accent="violet" label={t('kpi.newCustomers')} value={String(g.totalNewCustomers)} sub={t('sub.firstOrderInPeriod')} />
        <KpiCard icon={HeartPulse} accent={data.cohorts.overallRetention >= 50 ? 'emerald' : 'amber'} label={t('kpi.retentionRate')} value={`${data.cohorts.overallRetention}%`} sub={t('sub.activeLast6mo')} />
      </div>

      {k.overdueInvoices > 5 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">{t('overdueBanner.count', { count: k.overdueInvoices })}</span>{t('overdueBanner.rest')}</span>
        </p>
      ) : null}

      <Panel title={t('panels.monthlyRevenueTrend')} icon={BarChart3}>
        <GroupedBar
          labels={g.monthly.map((m) => m.label)}
          height={240}
          series={[{ name: t('table.revenue'), data: g.monthly.map((m) => m.revenue), color: '#0d9488' }]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.cohortRetention')} hint={t('panels.cohortHint')} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.cohort')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.customers')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.active')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.retention')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.avgLifetimeRev')}</th>
              </tr>
            </thead>
            <tbody>
              {data.cohorts.list.map((c) => (
                <tr key={c.year} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 font-medium text-slate-700 tabular-nums dark:text-slate-300">{c.year}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{c.totalCustomers}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{c.activeCustomers}</td>
                  <td className="px-4 py-2 text-right"><RetentionBadge v={c.retentionRate} /></td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(c.avgRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title={t('panels.monthlyDetails')} hint={t('panels.monthlyDetailsHint')} bodyClassName="p-0">
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.month')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.revenue')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.customers')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.new')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.txns')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.mom')}</th>
                </tr>
              </thead>
              <tbody>
                {g.monthly.map((m) => (
                  <tr key={m.month} className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', !m.isMature && 'opacity-60')}>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{m.label}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(m.revenue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{m.uniqueCustomers}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{m.newCustomers}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{m.transactionCount}</td>
                    <td className={cn('px-4 py-2 text-right font-medium tabular-nums', growthCls(m.growthRate))}>
                      {m.growthRate === null ? '—' : `${m.growthRate > 0 ? '+' : ''}${m.growthRate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- Profitability */
type ProfitSort = 'customerName' | 'totalRevenue' | 'totalCost' | 'grossProfit' | 'marginPct'
const PAGE_SIZE = 20

function ProfitabilityTab({ p }: { p: Profitability }) {
  const t = useTranslations('analytics.customer')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const marginLabel = (m: number): string => {
    if (m >= 40) return t('margin.excellent')
    if (m >= 25) return t('margin.good')
    if (m >= 10) return t('margin.fair')
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
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const SortTh = ({ label, col, align = 'right' }: { label: string; col: ProfitSort; align?: 'left' | 'right' }) => (
    <th className={cn('px-3 py-2 font-medium', align === 'right' ? 'text-right' : 'text-left')}>
      <button type="button" onClick={() => toggleSort(col)} className={cn('inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300', sortCol === col && 'text-teal-600 dark:text-teal-400')}>
        {label}
        {sortCol === col && <span className="text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={DollarSign} accent="emerald" label={t('kpi.totalRevenue')} value={money(s.totalRevenue)} sub={t('sub.customersCount', { count: s.customerCount })} />
        <KpiCard icon={FileText} accent="red" label={t('kpi.totalCosts')} value={money(s.totalCost)} sub={t('sub.jobsCount', { count: s.totalJobs })} />
        <KpiCard icon={HandCoins} accent={s.totalGrossProfit < 0 ? 'red' : 'sky'} label={t('kpi.grossProfit')} value={money(s.totalGrossProfit)} sub={s.totalGrossProfit < 0 ? t('margin.loss') : t('margin.profit')} tone={s.totalGrossProfit < 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Percent} accent={marginAccent(s.avgMarginPct)} label={t('kpi.avgMargin')} value={`${s.avgMarginPct.toFixed(1)}%`} sub={marginLabel(s.avgMarginPct)} />
      </div>

      {p.customers.length === 0 ? (
        <Panel title={t('panels.customerProfitability')} icon={Users}>
          <p className="py-8 text-center text-sm text-slate-400">{t('empty.noProjectProfitability')}</p>
        </Panel>
      ) : (
        <Panel title={t('panels.customerProfitability')} icon={Users} hint={t('panels.profitabilityHint', { threshold: money(100_000) })} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="w-8 px-2 py-2" />
                  <SortTh label={t('table.customerJob')} col="customerName" align="left" />
                  <SortTh label={t('table.revenue')} col="totalRevenue" />
                  <SortTh label={t('table.costs')} col="totalCost" />
                  <SortTh label={t('table.profit')} col="grossProfit" />
                  <SortTh label={t('table.margin')} col="marginPct" />
                  <th className="px-3 py-2 text-center font-medium">{t('table.tier')}</th>
                </tr>
              </thead>
              <tbody>
                {pageCustomers.map((c) => {
                  const isOpen = expanded.has(c.customerId)
                  return (
                    <GroupRows key={c.customerId}>
                      <tr
                        className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                        onClick={() => toggle(c.customerId)}
                      >
                        <td className="px-2 py-2.5 text-center text-slate-400">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{c.customerName}{c.isFakeChampion ? <span title={t('fakeChampionTitle')}> ⚠️</span> : null}</span>
                          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t('jobsCount', { count: c.jobs.length })}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{money(c.totalRevenue)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{money(c.totalCost)}</td>
                        <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', c.grossProfit < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{money(c.grossProfit)}</td>
                        <td className={cn('px-3 py-2.5 text-right font-bold tabular-nums', marginClass(c.marginPct))}>{c.marginPct.toFixed(1)}%</td>
                        <td className="px-3 py-2.5 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', PROFIT_TIER_STYLE[c.profitTier])}>{t(`profitTier.${c.profitTier}`)}</span></td>
                      </tr>
                      {isOpen
                        ? c.jobs.map((j) => (
                            <tr key={j.jobId} className="border-b border-slate-50 bg-slate-50/40 text-xs dark:border-slate-800/60 dark:bg-slate-800/20">
                              <td />
                              <td className="py-2 pr-3 pl-8">
                                <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                                  <FolderGit2 size={12} className="text-slate-400" />
                                  {j.jobName}
                                  {j.transactionCount ? <span className="text-slate-400 dark:text-slate-500">({t('txnsCount', { count: j.transactionCount })})</span> : null}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(j.revenue)}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(j.costs)}</td>
                              <td className={cn('px-3 py-2 text-right tabular-nums', j.profit < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300')}>{money(j.profit)}</td>
                              <td className={cn('px-3 py-2 text-right tabular-nums', marginClass(j.marginPct))}>{j.marginPct.toFixed(1)}%</td>
                              <td />
                            </tr>
                          ))
                        : null}
                    </GroupRows>
                  )
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={sorted.length} pageSize={PAGE_SIZE} onPage={setPage} noun={t('pager.nounCustomers')} />}
        </Panel>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- Configuration */
function ConfigurationTab({ data }: { data: CustomerData }) {
  const t = useTranslations('analytics.customer')
  const item = (label: string, value: string) => (
    <div className="flex items-center justify-between border-b border-slate-50 py-2 text-sm last:border-0 dark:border-slate-800/60">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-700 tabular-nums dark:text-slate-300">{value}</span>
    </div>
  )
  const c = data.config
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ConfigEditor
          dashboard="customerIntelligence"
          fields={[
            { key: 'churnCriticalScore', label: t('config.fields.churnCritical.label'), help: t('config.fields.churnCritical.help'), min: 1, max: 100, step: 1 },
            { key: 'churnHighScore', label: t('config.fields.churnHigh.label'), help: t('config.fields.churnHigh.help'), min: 1, max: 100, step: 1 },
            { key: 'churnMediumScore', label: t('config.fields.churnMedium.label'), help: t('config.fields.churnMedium.help'), min: 1, max: 100, step: 1 },
            { key: 'hhiWarning', label: t('config.fields.hhiWarning.label'), help: t('config.fields.hhiWarning.help'), min: 0, max: 10_000, step: 100 },
            { key: 'hhiCritical', label: t('config.fields.hhiCritical.label'), help: t('config.fields.hhiCritical.help'), min: 0, max: 10_000, step: 100 },
            { key: 'clvYears', label: t('config.fields.clvYears.label'), help: t('config.fields.clvYears.help'), min: 1, max: 10, step: 1 },
          ]}
          values={{ churnCriticalScore: c.churnCriticalScore, churnHighScore: c.churnHighScore, churnMediumScore: c.churnMediumScore, hhiWarning: c.hhiWarning, hhiCritical: c.hhiCritical, clvYears: c.clvYears }}
          defaults={{ churnCriticalScore: 70, churnHighScore: 50, churnMediumScore: 30, hhiWarning: 1500, hhiCritical: 2500, clvYears: 3 }}
        />
        <Panel title={t('panels.scoringModel')} hint={t('panels.scoringModelHint')}>
          {item(t('scoring.healthWeights.label'), t('scoring.healthWeights.value'))}
          {item(t('scoring.frictionPenalty.label'), t('scoring.frictionPenalty.value'))}
          {item(t('scoring.rfmRecency.label'), t('scoring.rfmRecency.value'))}
          {item(t('scoring.rfmFrequency.label'), t('scoring.rfmFrequency.value'))}
          {item(t('scoring.clvRetention.label'), t('scoring.clvRetention.value'))}
          {item(t('scoring.clvTiers.label'), t('scoring.clvTiers.value'))}
          {item(t('scoring.paymentScore.label'), t('scoring.paymentScore.value'))}
          {item(t('scoring.healthGrades.label'), t('scoring.healthGrades.value'))}
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
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">{t('sources.intelligenceBold')}</span> {t('sources.intelligenceTail', { score: data.intelligence.score, grade: data.intelligence.grade })}</li>
        </ul>
      </Panel>
    </div>
  )
}
