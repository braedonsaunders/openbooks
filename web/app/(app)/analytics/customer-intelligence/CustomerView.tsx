'use client'

import { useMemo, useState } from 'react'
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
import { exportCsv } from '../_ui/exportCsv'
import { useAnalyticsMoney, fmtPct } from '../_ui/format'

const TABS = ['overview', 'health', 'segmentation', 'lifetime', 'churn', 'growth', 'profitability', 'configuration'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  health: 'Health Scores',
  segmentation: 'Segmentation',
  lifetime: 'Lifetime Value',
  churn: 'Churn Risk',
  growth: 'Growth',
  profitability: 'Profitability',
  configuration: 'Configuration',
}

/* ------------------------------------------------------------ badge styles */
const PROFIT_TIER_LABEL: Record<ProfitTier, string> = { high: 'High', medium: 'Medium', low: 'Low', marginal: 'Marginal', loss: 'Loss' }
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
function marginLabel(m: number): string {
  if (m >= 40) return 'Excellent'
  if (m >= 25) return 'Good'
  if (m >= 10) return 'Fair'
  if (m >= 0) return 'Low'
  return 'Loss'
}
function marginAccent(m: number): 'emerald' | 'sky' | 'violet' | 'amber' | 'red' {
  if (m >= 40) return 'emerald'
  if (m >= 25) return 'sky'
  if (m >= 10) return 'violet'
  if (m >= 0) return 'amber'
  return 'red'
}

const TIER_LABEL: Record<Tier, string> = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' }
const TIER_STYLE: Record<Tier, string> = {
  platinum: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  gold: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  silver: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  bronze: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
}
const TIER_COLOR: Record<Tier, string> = { platinum: '#8b5cf6', gold: '#f59e0b', silver: '#94a3b8', bronze: '#f97316' }

const RISK_LABEL: Record<RiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }
const RISK_STYLE: Record<RiskLevel, string> = {
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  medium: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  high: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  critical: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const SEGMENTS: Segment[] = ['champions', 'loyal', 'potential', 'new', 'regular', 'hibernating', 'at-risk', 'lost']
const SEGMENT_LABEL: Record<Segment, string> = {
  champions: 'Champions',
  loyal: 'Loyal',
  potential: 'Potential',
  new: 'New',
  regular: 'Regular',
  hibernating: 'Hibernating',
  'at-risk': 'At Risk',
  lost: 'Lost',
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
const SEGMENT_DESC: Record<Segment, string> = {
  champions: 'Recent, frequent, high spend (R≥4 F≥4 M≥4)',
  loyal: 'Consistent high spenders (R≥3 F≥3 M≥4)',
  potential: 'Recent with solid value (R≥3 M≥3)',
  new: 'Recent first-time buyers (R≥4 F≤2)',
  regular: 'Moderate engagement',
  hibernating: 'Valuable but inactive (R≤2 F≥3 M≥3)',
  'at-risk': 'Low recency and frequency (R≤2 F≤2)',
  lost: 'Inactive, low value (R≤2 M≤2)',
}

const GRADE_STYLE: Record<CustomerRow['healthGrade'], string> = {
  'A+': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  A: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  B: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  C: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  F: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const REC_LABEL: Record<Recommendation, string> = {
  'resolve-issues': 'Resolve Issues',
  reactivate: 'Reactivate',
  'win-back': 'Win Back',
  nurture: 'Nurture',
  onboard: 'Onboard',
  reprice: 'Reprice',
  review: 'Review',
  maintain: 'Maintain',
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
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const tabs = projectsEnabled ? TABS : TABS.filter((key) => key !== 'profitability')
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const k = data.kpis
  const intel = data.intelligence
  const openCustomer = (r: Pick<CustomerRow, 'id' | 'name' | 'invoices' | 'revenue'>) =>
    setDrill({ kind: 'party', id: r.id, name: r.name, sub: `${r.invoices} invoices · ${money(r.revenue)}` })

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={intel.score} label={intel.label} size={132} thickness={12} showTicks={false} />
        </div>
        <KpiCard icon={Users} accent="sky" label="Total Customers" value={String(k.totalCustomers)} sub={`${k.newCustomers} new in period`} />
        <KpiCard icon={Crown} accent="violet" label="Champions" value={String(k.champions)} sub="RFM champions segment" />
        <KpiCard icon={Gem} accent="amber" label="Projected CLV" value={money(k.projectedClv)} sub="3-year projection" />
        <KpiCard icon={AlertOctagon} accent={k.atRiskCount > 0 ? 'red' : 'emerald'} label="At Risk" value={String(k.atRiskCount)} sub={money(k.atRiskRevenue)} tone={k.atRiskCount > 0 ? 'negative' : 'positive'} />
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
              {TAB_LABEL[key]}
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
      <Panel title="Key Metrics" icon={BarChart3}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {metric('Avg Value', money(k.avgCustomerValue), 'per customer')}
          {metric('Retention', `${k.retentionRate}%`, 'avg retention probability')}
          {metric('Payment Rate', `${k.paymentRate}%`, 'invoices paid in full')}
          {metric('Avg DSO', `${k.avgDaysToPay}d`, 'days to pay')}
          {metric('Top 10% Share', `${k.top10PctShare}%`, 'of revenue')}
          {metric('Monthly Growth', `${k.monthlyGrowth >= 0 ? '+' : ''}${k.monthlyGrowth}%`, 'avg MoM (mature months)')}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Top Customers by Revenue" icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => r.revenue)} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title="Revenue by CLV Tier" icon={PieIcon}>
          <Donut
            data={data.tierBreakdown.filter((x) => x.revenue > 0).map((x) => ({ name: TIER_LABEL[x.tier], value: x.revenue }))}
            colors={data.tierBreakdown.filter((x) => x.revenue > 0).map((x) => TIER_COLOR[x.tier])}
            height={220}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* RFM Segments bars —  */}
        <Panel title="RFM Segments" icon={Grid3x3} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.segments.map((s) => (
              <li key={s.segment} className="flex items-center gap-3 px-4 py-2">
                <span className={cn('w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold', SEGMENT_STYLE[s.segment])}>{SEGMENT_LABEL[s.segment]}</span>
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
        <Panel title="Intelligence Insights" icon={Lightbulb} bodyClassName="p-0">
          {data.insights.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">No notable signals for this period.</p>
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
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [page, setPage] = useState(1)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const rows = data.rows // already health-desc

  const groups = useMemo(() => {
    if (groupBy === 'none') return null
    const keyOf = (r: CustomerRow) =>
      groupBy === 'segment' ? SEGMENT_LABEL[r.segment] : groupBy === 'tier' ? TIER_LABEL[r.tier] : groupBy === 'churn' ? RISK_LABEL[r.churnLevel] : r.healthGrade
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
        <p className="font-medium text-slate-800 dark:text-slate-200">{r.name}{r.isFakeChampion ? <span title="High revenue, low margin — review pricing"> ⚠️</span> : null}</p>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">Last: {r.recencyDays >= 9999 ? '—' : `${r.recencyDays} days ago`}</p>
      </td>
      <td className="px-4 py-2 text-center">
        <span className={cn('mr-1.5 rounded-full px-2 py-0.5 text-xs font-bold', GRADE_STYLE[r.healthGrade])}>{r.healthGrade}</span>
        <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">{r.healthScore}</span>
      </td>
      <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-teal-600 dark:text-teal-400">{money(r.clv)}</td>
      <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEGMENT_STYLE[r.segment])}>{SEGMENT_LABEL[r.segment]}</span></td>
      <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.churnLevel])}>{RISK_LABEL[r.churnLevel]}</span></td>
      <td className="px-4 py-2 text-center text-xs text-slate-500 capitalize dark:text-slate-400">{r.paymentRating}</td>
      <td className="px-4 py-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', REC_STYLE[r.recommendation])} title={r.recommendationDetail}>{REC_LABEL[r.recommendation]}</span>
      </td>
    </tr>
  )

  const header = (
    <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
      <th className="px-4 py-2 text-left font-medium">Customer</th>
      <th className="px-4 py-2 text-center font-medium">Health</th>
      <th className="px-4 py-2 text-right font-medium">Revenue</th>
      <th className="px-4 py-2 text-right font-medium">Projected CLV</th>
      <th className="px-4 py-2 text-center font-medium">Segment</th>
      <th className="px-4 py-2 text-center font-medium">Churn</th>
      <th className="px-4 py-2 text-center font-medium">Payment</th>
      <th className="px-4 py-2 text-left font-medium">Recommendation</th>
    </tr>
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={HeartPulse} accent="teal" label="Avg Health" value={String(avgHealth)} sub="weighted R/F/M/payment" />
        <KpiCard icon={CheckCircle2} accent="emerald" label="Excellent" value={String(excellent)} sub="score ≥ 80" tone="positive" />
        <KpiCard icon={AlertTriangle} accent={warning > 0 ? 'amber' : 'emerald'} label="Warning" value={String(warning)} sub="score 40–59" />
        <KpiCard icon={AlertOctagon} accent={critical > 0 ? 'red' : 'emerald'} label="Critical" value={String(critical)} sub="score < 40" tone={critical > 0 ? 'negative' : 'positive'} />
      </div>

      <Panel
        title={`Customer Health (${rows.length})`}
        icon={HeartPulse}
        hint="Weighted 25% recency · 25% frequency · 30% monetary · 20% payment, minus friction penalty"
        bodyClassName="p-0"
        actions={
          <span className="flex items-center gap-2">
            <Select value={groupBy} onChange={(e) => { setGroupBy(e.target.value as GroupBy); setPage(1) }} className="w-40" triggerClassName="h-7 text-xs">
              <option value="none">No grouping</option>
              <option value="segment">By Segment</option>
              <option value="tier">By CLV Tier</option>
              <option value="churn">By Churn Risk</option>
              <option value="grade">By Health Grade</option>
            </Select>
            <button
              type="button"
              onClick={() => exportCsv('customer-health', ['Customer', 'Health', 'Grade', 'Revenue', 'Projected CLV', 'Segment', 'Churn', 'Payment', 'Recommendation'], rows.map((r) => [r.name, r.healthScore, r.healthGrade, Math.round(r.revenue), Math.round(r.clv), SEGMENT_LABEL[r.segment], RISK_LABEL[r.churnLevel], r.paymentRating, REC_LABEL[r.recommendation]]))}
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
                            <span className="ml-2 font-normal text-slate-400">{set.length} customers · {money(rev)}</span>
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
          <Pager page={pageNo} totalPages={totalPages} total={rows.length} pageSize={HEALTH_PAGE} onPage={setPage} noun="customers" />
        )}
      </Panel>
    </div>
  )
}

function GroupRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function Pager({ page, totalPages, total, pageSize, onPage, noun }: { page: number; totalPages: number; total: number; pageSize: number; onPage: (p: number) => void; noun: string }) {
  const start = (page - 1) * pageSize
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <span>Showing {start + 1}–{Math.min(start + pageSize, total)} of {total} {noun}</span>
      <div className="flex items-center gap-1">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Prev</button>
        <span className="px-2 tabular-nums">{page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Next</button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- Segmentation */
function SegmentationTab({ data }: { data: CustomerData }) {
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
            title={SEGMENT_DESC[s.segment]}
          >
            <span className={cn('inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold', SEGMENT_STYLE[s.segment])}>{SEGMENT_LABEL[s.segment]}</span>
            <p className="mt-1.5 text-xl font-semibold text-slate-800 tabular-nums dark:text-slate-100">{s.count}</p>
            <p className="text-[11px] text-slate-400 tabular-nums dark:text-slate-500">{s.percentage}% · {money(s.totalRevenue)}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Segment Performance" icon={Grid3x3} bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Segment</th>
                  <th className="px-4 py-2 text-right font-medium">Customers</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 text-right font-medium">Avg / Customer</th>
                  <th className="px-4 py-2 text-right font-medium">Rev Share</th>
                </tr>
              </thead>
              <tbody>
                {data.segments.map((s) => (
                  <tr key={s.segment} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', SEGMENT_STYLE[s.segment])}>{SEGMENT_LABEL[s.segment]}</span>
                      <span className="ml-2 hidden text-[11px] text-slate-400 lg:inline dark:text-slate-500">{SEGMENT_DESC[s.segment]}</span>
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
        <Panel title="Segment Mix" icon={PieIcon}>
          <Donut
            data={data.segments.filter((s) => s.count > 0).map((s) => ({ name: SEGMENT_LABEL[s.segment], value: s.count }))}
            colors={data.segments.filter((s) => s.count > 0).map((s) => SEGMENT_COLOR[s.segment])}
            valueFormat={(v) => `${Math.round(v)} customers`}
            height={220}
          />
        </Panel>
      </div>

      <Panel
        title={segment === 'all' ? `Customers by Segment (${filtered.length})` : `${SEGMENT_LABEL[segment]} (${filtered.length})`}
        icon={Users}
        hint="R/F/M scores: 5 best, 1 worst — recency from fixed day thresholds, frequency/monetary from 33rd/66th percentiles"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-center font-medium">R</th>
                <th className="px-4 py-2 text-center font-medium">F</th>
                <th className="px-4 py-2 text-center font-medium">M</th>
                <th className="px-4 py-2 text-center font-medium">Segment</th>
                <th className="px-4 py-2 text-right font-medium">Revenue</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 text-right font-medium">Recency</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                  <td className="px-4 py-2 text-center"><ScoreChip v={r.rfm.r} /></td>
                  <td className="px-4 py-2 text-center"><ScoreChip v={r.rfm.f} /></td>
                  <td className="px-4 py-2 text-center"><ScoreChip v={r.rfm.m} /></td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEGMENT_STYLE[r.segment])}>{SEGMENT_LABEL[r.segment]}</span></td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.revenue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.invoices}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays >= 9999 ? '—' : `${r.recencyDays}d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={filtered.length} pageSize={25} onPage={setPage} noun="customers" />}
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
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [page, setPage] = useState(1)
  const k = data.kpis
  const byClv = [...data.rows].sort((a, b) => b.clv - a.clv)
  const totalPages = Math.max(1, Math.ceil(byClv.length / 25))
  const pageNo = Math.min(page, totalPages)
  const pageRows = byClv.slice((pageNo - 1) * 25, pageNo * 25)
  const maxTier = Math.max(1, ...data.tierBreakdown.map((t) => t.count))

  return (
    <div className="space-y-5">
      <div className={projectsEnabled ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'grid grid-cols-2 gap-3'}>
        <KpiCard icon={Gem} accent="violet" label="Total Projected CLV" value={money(k.projectedClv)} sub={`avg ${money(k.avgClv)} / customer`} />
        <KpiCard icon={DollarSign} accent="emerald" label="Period Revenue" value={money(k.totalRevenue)} sub="historical CLV base" />
        {projectsEnabled ? (
          <>
            <KpiCard icon={HandCoins} accent={profitability.summary.totalGrossProfit < 0 ? 'red' : 'sky'} label="Gross Profit" value={money(profitability.summary.totalGrossProfit)} sub={`${profitability.summary.avgMarginPct.toFixed(1)}% margin`} />
            <KpiCard icon={AlertTriangle} accent={k.fakeChampions > 0 ? 'amber' : 'emerald'} label="Profit Leaks" value={String(k.fakeChampions)} sub="high revenue, <15% margin" tone={k.fakeChampions > 0 ? 'negative' : 'positive'} />
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="CLV Tier Distribution" icon={Layers} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.tierBreakdown.map((t) => (
              <li key={t.tier} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn('w-20 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold', TIER_STYLE[t.tier])}>{TIER_LABEL[t.tier]}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded-full" style={{ width: `${(t.count / maxTier) * 100}%`, backgroundColor: TIER_COLOR[t.tier] }} />
                </div>
                <span className="w-24 text-right text-xs text-slate-500 tabular-nums dark:text-slate-400">{t.count} · {money(t.revenue)}</span>
                <span className="w-20 text-right text-[11px] text-slate-400 tabular-nums dark:text-slate-500">{t.threshold > 0 ? `≥ ${money(t.threshold)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="How CLV is projected" icon={Info}>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Annual value</span> = avg invoice × (invoices ÷ years active, floor 3 months).{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">Retention factor</span> = 0.95·e<sup>−days since last ÷ 120</sup>, clamped 10–95%.{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">Projected CLV</span> = annual value × 3 years × retention.
            Tiers rank by projected CLV: top 10% Platinum, next 20% Gold, next 30% Silver, bottom 40% Bronze.
          </p>
          <div className="mt-3">
            <GroupedBar
              labels={data.tierBreakdown.map((t) => TIER_LABEL[t.tier])}
              height={180}
              series={[{ name: 'Projected CLV', data: data.tierBreakdown.map((t) => data.rows.filter((r) => r.tier === t.tier).reduce((a, r) => a + r.clv, 0)), color: '#0d9488' }]}
            />
          </div>
        </Panel>
      </div>

      <Panel title="Lifetime Value Ranking" icon={Gem} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">#</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-center font-medium">Tier</th>
                <th className="px-4 py-2 text-right font-medium">Revenue</th>
                <th className="px-4 py-2 text-right font-medium">Margin</th>
                <th className="px-4 py-2 text-right font-medium">Annual Value</th>
                <th className="px-4 py-2 text-right font-medium">Projected CLV</th>
                <th className="px-4 py-2 text-right font-medium">Retention</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-400 tabular-nums dark:text-slate-500">{r.clvRank}</td>
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}{r.isFakeChampion ? <span title="High revenue, low margin"> ⚠️</span> : null}</td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', TIER_STYLE[r.tier])}>{TIER_LABEL[r.tier]}</span></td>
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
        {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={byClv.length} pageSize={25} onPage={setPage} noun="customers" />}
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------------- Churn */
function ChurnTab({ data }: { data: CustomerData }) {
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
        <KpiCard icon={AlertOctagon} accent={k.atRiskCount > 0 ? 'red' : 'emerald'} label="Recency Risk" value={String(k.atRiskCount)} sub="high + critical churn" tone={k.atRiskCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Undo2} accent={k.criticalFriction + k.highFriction > 0 ? 'amber' : 'emerald'} label="High Friction" value={String(k.criticalFriction + k.highFriction)} sub="credit-heavy accounts" />
        <KpiCard icon={CalendarClock} accent={k.overdueOrders > 0 ? 'amber' : 'emerald'} label="Overdue Orders" value={String(k.overdueOrders)} sub="past their usual cycle" />
        <KpiCard icon={DollarSign} accent={k.atRiskRevenue > 0 ? 'red' : 'emerald'} label="At Risk Revenue" value={money(k.atRiskRevenue)} sub="high + critical accounts" tone={k.atRiskRevenue > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Friction Signals" icon={Undo2} hint="Credits ×2 points (no return-authorization docs on this ledger, so returns are always 0)" bodyClassName="p-0">
          {friction.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">No credit-memo friction in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-right font-medium">Credits</th>
                  <th className="px-4 py-2 text-right font-medium">Credit Value</th>
                  <th className="px-4 py-2 text-right font-medium">Issue Rate</th>
                  <th className="px-4 py-2 text-center font-medium">Level</th>
                </tr>
              </thead>
              <tbody>
                {friction.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.creditCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{money(r.creditValue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.returnRate.toFixed(1)}%</td>
                    <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.frictionLevel])}>{RISK_LABEL[r.frictionLevel]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Overdue Orders" icon={CalendarClock} hint="Days past each customer's own average order cycle" bodyClassName="p-0">
          {overdue.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">Nobody is past their usual ordering cycle.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-right font-medium">Avg Cycle</th>
                  <th className="px-4 py-2 text-right font-medium">Overdue</th>
                  <th className="px-4 py-2 text-center font-medium">Urgency</th>
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
        title={`At-Risk Customers (${atRisk.length})`}
        icon={AlertOctagon}
        hint="Churn score: recency 0–40 (>120d/>60d/>30d) + cadence decline 0–30 (2×/1.5× own average) + low engagement 0–30 (≤1/≤3 orders)"
        bodyClassName="p-0"
      >
        {atRisk.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-slate-400">No at-risk customers — retention looks healthy.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Customer</th>
                    <th className="px-4 py-2 text-center font-medium">Risk</th>
                    <th className="px-4 py-2 text-right font-medium">Score</th>
                    <th className="px-4 py-2 text-right font-medium">Days Inactive</th>
                    <th className="px-4 py-2 text-right font-medium">Revenue</th>
                    <th className="px-4 py-2 text-right font-medium">Retention Prob.</th>
                    <th className="px-4 py-2 text-left font-medium">Risk Factors</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                      <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', RISK_STYLE[r.churnLevel])}>{RISK_LABEL[r.churnLevel]}</span></td>
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
            {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={atRisk.length} pageSize={25} onPage={setPage} noun="customers" />}
          </>
        )}
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------------- Growth */
function GrowthTab({ data }: { data: CustomerData }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const g = data.growth
  const k = data.kpis
  const growthCls = (v: number | null) => (v === null ? 'text-slate-400 dark:text-slate-500' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : v < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard icon={TrendingUp} accent={(g.yoyGrowth ?? 0) >= 0 ? 'emerald' : 'red'} label="YoY Growth" value={g.yoyGrowth === null ? '—' : `${g.yoyGrowth >= 0 ? '+' : ''}${g.yoyGrowth}%`} sub="last 3mo vs same period LY" tone={(g.yoyGrowth ?? 0) >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={BarChart3} accent={g.avgMonthlyGrowth >= 0 ? 'teal' : 'amber'} label="Avg Monthly" value={`${g.avgMonthlyGrowth >= 0 ? '+' : ''}${g.avgMonthlyGrowth}%`} sub={`trend: ${g.trend}`} />
        <KpiCard icon={DollarSign} accent="sky" label="Median Monthly" value={money(g.medianMonthlyRevenue)} sub="revenue" />
        <KpiCard icon={Users} accent="violet" label="New Customers" value={String(g.totalNewCustomers)} sub="first order in period" />
        <KpiCard icon={HeartPulse} accent={data.cohorts.overallRetention >= 50 ? 'emerald' : 'amber'} label="Retention Rate" value={`${data.cohorts.overallRetention}%`} sub="active in last 6 months" />
      </div>

      {k.overdueInvoices > 5 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">{k.overdueInvoices} overdue invoices</span> in this period — collections risk can mask growth. Review the Churn Risk tab.</span>
        </p>
      ) : null}

      <Panel title="Monthly Revenue Trend" icon={BarChart3}>
        <GroupedBar
          labels={g.monthly.map((m) => m.label)}
          height={240}
          series={[{ name: 'Revenue', data: g.monthly.map((m) => m.revenue), color: '#0d9488' }]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Cohort Retention" icon={Layers} hint="By first-order year · active = ordered in the last 6 months" bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Cohort</th>
                <th className="px-4 py-2 text-right font-medium">Customers</th>
                <th className="px-4 py-2 text-right font-medium">Active</th>
                <th className="px-4 py-2 text-right font-medium">Retention</th>
                <th className="px-4 py-2 text-right font-medium">Avg Lifetime Rev</th>
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

        <Panel title="Monthly Details" icon={CalendarClock} hint="MoM growth capped +200/−80%; '—' marks ramp-up from an immature month" bodyClassName="p-0">
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Month</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 text-right font-medium">Customers</th>
                  <th className="px-4 py-2 text-right font-medium">New</th>
                  <th className="px-4 py-2 text-right font-medium">Txns</th>
                  <th className="px-4 py-2 text-right font-medium">MoM</th>
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
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
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
        <KpiCard icon={DollarSign} accent="emerald" label="Total Revenue" value={money(s.totalRevenue)} sub={`${s.customerCount} customers`} />
        <KpiCard icon={FileText} accent="red" label="Total Costs" value={money(s.totalCost)} sub={`${s.totalJobs} jobs`} />
        <KpiCard icon={HandCoins} accent={s.totalGrossProfit < 0 ? 'red' : 'sky'} label="Gross Profit" value={money(s.totalGrossProfit)} sub={s.totalGrossProfit < 0 ? 'Loss' : 'Profit'} tone={s.totalGrossProfit < 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Percent} accent={marginAccent(s.avgMarginPct)} label="Avg Margin" value={`${s.avgMarginPct.toFixed(1)}%`} sub={marginLabel(s.avgMarginPct)} />
      </div>

      {p.customers.length === 0 ? (
        <Panel title="Customer Profitability" icon={Users}>
          <p className="py-8 text-center text-sm text-slate-400">No project-tagged profitability for this period.</p>
        </Panel>
      ) : (
        <Panel title="Customer Profitability" icon={Users} hint={`Click a customer to expand jobs · ⚠️ marks profit leaks (>${money(100_000)} revenue, <15% margin)`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="w-8 px-2 py-2" />
                  <SortTh label="Customer / Job" col="customerName" align="left" />
                  <SortTh label="Revenue" col="totalRevenue" />
                  <SortTh label="Costs" col="totalCost" />
                  <SortTh label="Profit" col="grossProfit" />
                  <SortTh label="Margin" col="marginPct" />
                  <th className="px-3 py-2 text-center font-medium">Tier</th>
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
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{c.customerName}{c.isFakeChampion ? <span title="High revenue, low margin — review pricing"> ⚠️</span> : null}</span>
                          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{c.jobs.length} jobs</span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{money(c.totalRevenue)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{money(c.totalCost)}</td>
                        <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', c.grossProfit < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{money(c.grossProfit)}</td>
                        <td className={cn('px-3 py-2.5 text-right font-bold tabular-nums', marginClass(c.marginPct))}>{c.marginPct.toFixed(1)}%</td>
                        <td className="px-3 py-2.5 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', PROFIT_TIER_STYLE[c.profitTier])}>{PROFIT_TIER_LABEL[c.profitTier]}</span></td>
                      </tr>
                      {isOpen
                        ? c.jobs.map((j) => (
                            <tr key={j.jobId} className="border-b border-slate-50 bg-slate-50/40 text-xs dark:border-slate-800/60 dark:bg-slate-800/20">
                              <td />
                              <td className="py-2 pr-3 pl-8">
                                <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                                  <FolderGit2 size={12} className="text-slate-400" />
                                  {j.jobName}
                                  {j.transactionCount ? <span className="text-slate-400 dark:text-slate-500">({j.transactionCount} txns)</span> : null}
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
          {totalPages > 1 && <Pager page={pageNo} totalPages={totalPages} total={sorted.length} pageSize={PAGE_SIZE} onPage={setPage} noun="customers" />}
        </Panel>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- Configuration */
function ConfigurationTab({ data }: { data: CustomerData }) {
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
            { key: 'churnCriticalScore', label: 'Churn — critical (score)', help: 'Composite churn score at or above this reads as critical risk', min: 1, max: 100, step: 1 },
            { key: 'churnHighScore', label: 'Churn — high (score)', help: 'Composite churn score at or above this reads as high risk', min: 1, max: 100, step: 1 },
            { key: 'churnMediumScore', label: 'Churn — medium (score)', help: 'Composite churn score at or above this reads as medium risk', min: 1, max: 100, step: 1 },
            { key: 'hhiWarning', label: 'Concentration warning (HHI)', help: 'Herfindahl index at or above this flags a concentration warning', min: 0, max: 10_000, step: 100 },
            { key: 'hhiCritical', label: 'Concentration critical (HHI)', help: 'Herfindahl index at or above this flags critical concentration', min: 0, max: 10_000, step: 100 },
            { key: 'clvYears', label: 'CLV horizon (years)', help: 'Years of forward value in the lifetime-value projection', min: 1, max: 10, step: 1 },
          ]}
          values={{ churnCriticalScore: c.churnCriticalScore, churnHighScore: c.churnHighScore, churnMediumScore: c.churnMediumScore, hhiWarning: c.hhiWarning, hhiCritical: c.hhiCritical, clvYears: c.clvYears }}
          defaults={{ churnCriticalScore: 70, churnHighScore: 50, churnMediumScore: 30, hhiWarning: 1500, hhiCritical: 2500, clvYears: 3 }}
        />
        <Panel title="Scoring Model" icon={Settings2} hint="How the composite scores are built">
          {item('Health weights', 'Recency 25% · Frequency 25% · Monetary 30% · Payment 20%')}
          {item('Friction penalty', 'Critical −25 · High −15 · Medium −8')}
          {item('RFM recency thresholds', '≤30d → 5 · ≤90d → 3 · ≤180d → 2 · else 1')}
          {item('RFM frequency / monetary', '33rd & 66th percentile cuts → 1 / 3 / 5')}
          {item('CLV retention', 'retention 0.95·e^(−days/120), clamped 10–95%')}
          {item('CLV tiers', 'Top 10% Platinum · next 20% Gold · next 30% Silver · rest Bronze')}
          {item('Payment score', '100 − 40/20/10 by DSO >60/>30/>15d − min(40, overdue×10)')}
          {item('Health grades', 'A+ ≥90 · A ≥80 · B ≥70 · C ≥60 · D ≥50 · F below')}
        </Panel>
      </div>
      <Panel title="Data Sources & Derivations" icon={Timer}>
        <ul className="space-y-2.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Revenue basis:</span> posted customer-invoice document totals.</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Recency:</span> measured to today (or the period end when historical), never a future fiscal-year end.</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Friction:</span> credit memos only — this ledger has no return-authorization documents, so the returns component is always 0.</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Payment behavior:</span> paid = invoice fully applied; days-to-pay = final payment application date − invoice date; overdue = past due date and not fully applied.</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">New customers:</span> no earlier invoice or sales order, lifetime, before the month of first activity.</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Cohorts:</span> lifetime invoice history grouped by first-order year; active = ordered within the last 6 months.</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Profitability:</span> project-tagged GL lines rolled job → customer; customers without project-tagged activity show no margin (never estimated).</li>
          <li><span className="font-semibold text-slate-700 dark:text-slate-300">Intelligence score:</span> 30% champions share (20% of customers = max) + 30% avg retention probability + 20% concentration health + 20% payment rate — score {data.intelligence.score} ({data.intelligence.grade}).</li>
        </ul>
      </Panel>
    </div>
  )
}
