'use client'

import { useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, BarChart3, Bolt, Bug, CalendarRange, ChartArea,
  CheckCircle2, DollarSign, Flame, Ghost, Info, Layers, Lightbulb, Mountain,
  PieChart as PieIcon, Puzzle, Search, SlidersHorizontal, Snowflake, Target, TrendingDown,
  TrendingUp, UserRound, PiggyBank, Gauge as GaugeIcon, Download,
} from 'lucide-react'
import { cn, Select, Badge } from '@openbooks/ui'
import type { SpendVelocityData, VelocityRow } from '../../../../lib/analytics/spend-velocity-data'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { Donut, Chart, TrendChart } from '../_ui/charts'
import { DrillDrawer } from '../_ui/DrillDrawer'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { useAnalyticsMoney } from '../_ui/format'

/* ------------------------------------------------------------------ helpers */

// 'expenses' moved out: the expense-report analysis now lives on the /expenses dashboard.
const TABS = ['overview', 'velocity', 'detectors', 'accounts', 'trends', 'config'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview', velocity: 'Velocity', detectors: 'Detectors', accounts: 'Accounts',
  trends: 'Trends', config: 'Configuration',
}
const pct1 = (v: number, d = 1) => `${v.toFixed(d)}%`

/** Velocity pill colouring: hot >15, warm >5, cold <−5, else cool. */
function velTone(v: number) {
  if (v > 15) return 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400'
  if (v > 5) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400'
  if (v < -5) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
}

function VelocityPill({ v }: { v: number }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', velTone(v))}>
      {v >= 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
      {Math.abs(v).toFixed(1)}%
    </span>
  )
}

/** Acceleration indicator (±1 / ±3 thresholds). */
function Accel({ a }: { a: number }) {
  const tone = a > 3 ? 'text-rose-600 dark:text-rose-400' : a > 1 ? 'text-amber-600 dark:text-amber-400'
    : a < -3 ? 'text-emerald-600 dark:text-emerald-400' : a < -1 ? 'text-sky-600 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'
  return <span className={cn('text-xs font-semibold tabular-nums', tone)}>{a >= 0 ? '+' : '−'}{Math.abs(a).toFixed(1)}%</span>
}

const TREND_BADGE: Record<VelocityRow['trend'], { label: string; cls: string }> = {
  accelerating: { label: 'Accelerating', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' },
  high: { label: 'High', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400' },
  rising: { label: 'Rising', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' },
  declining: { label: 'Declining', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400' },
  stable: { label: 'Stable', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  new: { label: 'New', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400' },
}

/** Pure-SVG sparkline for compact table cells (60×20). */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-xs text-slate-300">—</span>
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const w = 64, h = 20
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / range) * (h - 4)}`).join(' ')
  return (
    <svg width={w} height={h} className="opacity-80">
      <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="1.5" />
    </svg>
  )
}

/** Health gauge (Risk-meter): score 0-100 → colour + grade. */
function HealthGauge({ score, grade }: { score: number; grade: string }) {
  const color = score >= 80 ? '#10b981' : score >= 70 ? '#f59e0b' : score >= 60 ? '#f97316' : '#ef4444'
  const label = score >= 80 ? 'HEALTHY' : score >= 70 ? 'WATCH' : score >= 60 ? 'ELEVATED' : 'AT RISK'
  const arcLength = 141.37
  const offset = arcLength * (1 - Math.min(score, 100) / 100)
  return (
    <div className="flex h-full items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <svg width="92" height="52" viewBox="0 0 100 55" className="shrink-0">
        <path d="M 5 50 A 45 45 0 0 1 95 50" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" className="text-slate-200 dark:text-slate-700" />
        <path d="M 5 50 A 45 45 0 0 1 95 50" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={arcLength} strokeDashoffset={offset} style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <div className="min-w-0">
        <p className="text-xl font-bold tabular-nums" style={{ color }}>{score} <span className="text-sm">({grade})</span></p>
        <p className="text-[10px] font-bold tracking-wider" style={{ color }}>{label}</p>
        <p className="text-[10px] text-slate-400 dark:text-slate-500">spend health</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ drill drawer */

type Drill = { kind: 'account' | 'vendor'; id: string; name: string } | null

/* ------------------------------------------------------------------- shell */

export function SpendVelocityView({ data }: { data: SpendVelocityData }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<Drill>(null)
  const s = data.summary

  const vel = s.avgVelocity
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <HealthGauge score={s.healthScore} grade={s.healthGrade} />
        <KpiCard icon={DollarSign} accent="sky" label="Total Spend" value={money(s.totalSpend)} sub={`${s.accountCount} accounts`} />
        <KpiCard icon={GaugeIcon} accent={vel > 5 ? 'red' : vel < -5 ? 'emerald' : 'slate'} label="Avg Velocity" value={`${vel > 0 ? '↑' : vel < 0 ? '↓' : ''} ${Math.abs(vel).toFixed(1)}%`} sub={`${s.acceleratingCount} accelerating`} tone={vel > 5 ? 'negative' : vel < -5 ? 'positive' : 'neutral'} />
        <KpiCard icon={PiggyBank} accent="violet" label="Savings Potential" value={money(s.savingsPotential)} sub={s.savingsPotential > 0 ? 'from creep + zombies' : 'no issues found'} />
        <KpiCard icon={AlertTriangle} accent={s.totalAlerts > 0 ? 'red' : 'emerald'} label="Alerts" value={String(s.totalAlerts)} sub={`${data.anomalies.summary.count} anomalies`} tone={s.totalAlerts > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {TAB_LABEL[k]}
              {k === 'detectors' && s.totalAlerts > 0 ? <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{s.totalAlerts}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} onDrill={setDrill} /> : null}
        {tab === 'velocity' ? <VelocityTab data={data} onDrill={setDrill} /> : null}
        {tab === 'detectors' ? <DetectorsTab data={data} onDrill={setDrill} /> : null}
        {tab === 'accounts' ? <AccountsTab data={data} onDrill={setDrill} /> : null}
        {tab === 'trends' ? <TrendsTab data={data} /> : null}
        {tab === 'config' ? <ConfigTab data={data} /> : null}
      </div>

      <DrillDrawer
        target={drill ? { kind: drill.kind === 'vendor' ? 'party' : 'account', id: drill.id, name: drill.name } : null}
        from={data.period.from}
        to={data.period.to}
        onClose={() => setDrill(null)}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */

function OverviewTab({ data, onDrill }: { data: SpendVelocityData; onDrill: (d: Drill) => void }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const accounts = data.accountVelocity
  const byVelocity = [...accounts].sort((a, b) => b.velocity - a.velocity).slice(0, 6)
  const top10 = accounts.slice(0, 10)

  // IQR-based scatter bounds (stable).
  const scatterOption = useMemo(() => {
    const vels = accounts.map((a) => a.velocity)
    const accels = accounts.map((a) => a.acceleration)
    const iqr = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b)
      const q1 = sorted[Math.floor(sorted.length * 0.25)] ?? 0
      const q3 = sorted[Math.floor(sorted.length * 0.75)] ?? 0
      return { min: q1 - 1.5 * (q3 - q1), max: q3 + 1.5 * (q3 - q1) }
    }
    const vB = iqr(vels), aB = iqr(accels)
    const vMin = Math.max(vB.min, Math.min(...vels)), vMax = Math.min(vB.max, Math.max(...vels))
    const aMin = Math.max(aB.min, Math.min(...accels)), aMax = Math.min(aB.max, Math.max(...accels))
    const vPad = Math.max(2, (vMax - vMin) * 0.15), aPad = Math.max(1, (aMax - aMin) * 0.15)
    const maxSpend = Math.max(...accounts.map((a) => a.totalSpend), 1)
    return {
      grid: { top: 12, bottom: 34, left: 48, right: 16 },
      xAxis: { type: 'value' as const, name: 'Velocity %', nameLocation: 'middle' as const, nameGap: 24, min: vMin - vPad, max: vMax + vPad },
      yAxis: { type: 'value' as const, name: 'Accel', min: aMin - aPad, max: aMax + aPad },
      tooltip: {
        formatter: (p: any) => `<b>${p.data[3]}</b><br/>Velocity: ${p.data[0].toFixed(1)}%<br/>Accel: ${p.data[1].toFixed(1)}%<br/>Spend: ${money(p.data[2])}`,
      },
      series: [{
        type: 'scatter' as const,
        symbolSize: (d: number[]) => Math.max(8, Math.min(25, 8 + (d[2] / maxSpend) * 17)),
        data: accounts.map((a) => [a.velocity, a.acceleration, a.totalSpend, a.name]),
        itemStyle: {
          color: (p: any) => {
            const v = p.data[0]
            return v > 15 ? '#dc2626' : v > 5 ? '#f97316' : v < -5 ? '#10b981' : '#94a3b8'
          },
          borderColor: 'rgba(255,255,255,0.5)', borderWidth: 1, opacity: 0.85,
        },
      }],
    }
  }, [accounts])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title="Velocity vs Acceleration" icon={Target} hint="Velocity = monthly spend change · Acceleration = change in velocity · size = spend">
            <Chart option={scatterOption} height={220} />
          </Panel>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Panel title="Top 10 by Spend" icon={PieIcon}>
              <Donut data={top10.map((a) => ({ name: a.name, value: a.totalSpend }))} height={210} />
            </Panel>
            <Panel title="Monthly Trend" icon={ChartArea}>
              <TrendChart labels={data.monthlyTrends.map((m) => m.month)} area height={210} series={[{ name: 'Spend', data: data.monthlyTrends.map((m) => m.totalAmount), color: '#6366f1' }]} />
            </Panel>
          </div>
          <Panel title="Highest Velocity Accounts" icon={Flame} bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Spend</th>
                  <th className="px-4 py-2 text-right font-medium">Velocity</th>
                  <th className="px-4 py-2 text-center font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {byVelocity.map((a) => (
                  <tr key={a.id} onClick={() => onDrill({ kind: 'account', id: a.id, name: a.name })} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-200">{a.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(a.totalSpend)}</td>
                    <td className="px-4 py-2 text-right"><VelocityPill v={a.velocity} /></td>
                    <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', TREND_BADGE[a.trend].cls)}>{TREND_BADGE[a.trend].label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel title="Insights" icon={Lightbulb} actions={<Badge variant={data.insights.length > 3 ? 'destructive' : data.insights.length > 0 ? 'warning' : 'success'}>{data.insights.length}</Badge>} bodyClassName="p-0">
            {data.insights.length ? (
              <ul className="max-h-80 divide-y divide-slate-50 overflow-y-auto dark:divide-slate-800/60">
                {data.insights.slice(0, 6).map((i, k) => (
                  <li key={k} className="flex items-start gap-2.5 px-4 py-2.5">
                    <AlertTriangle size={14} className={cn('mt-0.5 shrink-0', i.type === 'alert' ? 'text-rose-500' : i.type === 'warning' ? 'text-amber-500' : 'text-sky-500')} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{i.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{i.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-4 py-6 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={15} />No anomalies detected</p>
            )}
          </Panel>
          <Panel title="Detector Summary" icon={Search}>
            <DetectorGrid data={data} compact />
          </Panel>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------- detector grid (shared) */

function DetectorGrid({ data, compact, selected, onSelect }: { data: SpendVelocityData; compact?: boolean; selected?: string; onSelect?: (k: string) => void }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const cliff = data.commitmentCliff.summary
  const tiles: { key: string; label: string; icon: typeof Bug; tone: string; count: string; active: boolean; metric: string; sub: string; desc: string }[] = [
    { key: 'frog', label: 'Boiling Frog', icon: Bug, tone: 'text-violet-500', count: String(data.boilingFrog.summary.count), active: data.boilingFrog.summary.count > 0, metric: money(data.boilingFrog.summary.totalAnnualizedCreep), sub: 'annual impact', desc: 'Silent cost creep' },
    { key: 'anomaly', label: 'Anomalies', icon: Bolt, tone: 'text-rose-500', count: String(data.anomalies.summary.count), active: data.anomalies.summary.count > 0, metric: String(data.anomalies.summary.criticalCount), sub: 'critical', desc: 'Statistical outliers (>2.5σ)' },
    { key: 'zombie', label: 'Zombies', icon: Ghost, tone: 'text-slate-400', count: String(data.zombies.summary.count), active: data.zombies.summary.count > 0, metric: money(data.zombies.summary.totalAnnualCost), sub: 'annual cost', desc: 'Unchanged recurring costs' },
    { key: 'fragmentation', label: 'Fragmentation', icon: Puzzle, tone: 'text-orange-500', count: String(data.fragmentation.summary.fragmentedCategories), active: data.fragmentation.summary.fragmentedCategories > 0, metric: money(data.fragmentation.summary.totalFragmentedSpend), sub: 'fragmented spend', desc: 'Many small purchases' },
    { key: 'concentration', label: 'Concentration', icon: PieIcon, tone: 'text-amber-500', count: `${Math.round(data.concentration.summary.top1Share)}%`, active: data.concentration.summary.top1Share > 25, metric: `${Math.round(data.concentration.summary.top5Share)}%`, sub: 'top 5 share', desc: 'Category over-reliance' },
    { key: 'cliff', label: 'Commit. Cliff', icon: Mountain, tone: 'text-sky-500', count: `${cliff.velocityGap}%`, active: cliff.status !== 'healthy', metric: `${cliff.poVelocity}%`, sub: 'PO velocity', desc: 'PO vs SO velocity gap' },
    { key: 'seasonal', label: 'Seasonal', icon: Snowflake, tone: 'text-teal-500', count: String(data.seasonal.insights.length), active: data.seasonal.insights.length > 0, metric: String(data.seasonal.patterns.filter((p) => p.isHigh || p.isLow).length), sub: 'off-pattern months', desc: 'Off-pattern spending' },
    { key: 'shadow', label: 'Shadow IT', icon: Bug, tone: 'text-pink-500', count: '—', active: false, metric: '—', sub: 'not available', desc: 'Viral software adoption' },
  ]

  if (compact) {
    return (
      <div className="grid grid-cols-4 gap-2 text-center">
        {tiles.map((t) => {
          const Icon = t.icon
          return (
            <div key={t.key} className={cn('rounded-lg p-2', t.active ? 'bg-slate-100 dark:bg-slate-800' : 'bg-slate-50/60 dark:bg-slate-800/40')}>
              <Icon size={13} className={cn('mx-auto', t.tone)} />
              <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-200">{t.count}</p>
              <p className="text-[9px] text-slate-400 dark:text-slate-500">{t.label}</p>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((t) => {
        const Icon = t.icon
        return (
          <button
            key={t.key}
            type="button"
            onClick={onSelect ? () => onSelect(selected === t.key ? 'all' : t.key) : undefined}
            className={cn(
              'rounded-xl border bg-white p-3.5 text-left shadow-sm transition-colors dark:bg-slate-900',
              selected === t.key ? 'border-teal-500 ring-1 ring-teal-500' : t.active ? 'border-slate-300 dark:border-slate-700' : 'border-slate-200/80 dark:border-slate-800',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-bold text-slate-800 dark:text-slate-200"><Icon size={14} className={t.tone} />{t.label}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold tabular-nums', t.active ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>{t.count}</span>
            </div>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t.desc}</p>
            <p className="mt-2 text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{t.metric} <span className="text-xs font-normal text-slate-400">{t.sub}</span></p>
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- Velocity */

function VelocityTab({ data, onDrill }: { data: SpendVelocityData; onDrill: (d: Drill) => void }) {
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <Panel title="Expense Account Velocity" icon={Layers} actions={<Badge>{data.accountVelocity.length}</Badge>} bodyClassName="p-0">
          <div className="max-h-128 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Spend</th>
                  <th className="px-4 py-2 text-right font-medium">Bills/Exp</th>
                  <th className="px-4 py-2 text-right font-medium">Velocity</th>
                  <th className="px-4 py-2 text-center font-medium">Accel.</th>
                  <th className="px-4 py-2 text-left font-medium">Sparkline</th>
                </tr>
              </thead>
              <tbody>
                {data.accountVelocity.map((a) => (
                  <tr key={a.id} onClick={() => onDrill({ kind: 'account', id: a.id, name: a.name })} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2">
                      <p className="font-medium text-slate-800 dark:text-slate-200">{a.name}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500">{a.transactionCount} txns · {a.monthCount} months</p>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(a.totalSpend)}</td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{a.billPct}% / {a.expensePct}%</td>
                    <td className="px-4 py-2 text-right"><VelocityPill v={a.velocity} /></td>
                    <td className="px-4 py-2 text-center"><Accel a={a.acceleration} /></td>
                    <td className="px-4 py-2"><Spark values={a.monthlyAmounts} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
      <div className="lg:col-span-5">
        <Panel title="Vendor Drill-Down" icon={UserRound} actions={<Badge variant="secondary">{data.vendorVelocity.length}</Badge>} bodyClassName="p-0">
          <div className="max-h-128 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Vendor</th>
                  <th className="px-4 py-2 text-right font-medium">Spend</th>
                  <th className="px-4 py-2 text-right font-medium">Velocity</th>
                </tr>
              </thead>
              <tbody>
                {data.vendorVelocity.map((v) => (
                  <tr key={v.id} onClick={() => onDrill({ kind: 'vendor', id: v.id, name: v.name })} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2">
                      <p className="font-medium text-slate-800 dark:text-slate-200">{v.name}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500">{v.transactionCount} txns</p>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(v.totalSpend)}</td>
                    <td className="px-4 py-2 text-right"><VelocityPill v={v.velocity} /></td>
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

/* --------------------------------------------------------------- Detectors */

interface Alert {
  detector: string
  label: string
  item: string
  severity: 'Critical' | 'High' | 'Medium' | 'Low'
  impact: number
  details: string
  accountId?: string
  vendorId?: string
}

function DetectorsTab({ data, onDrill }: { data: SpendVelocityData; onDrill: (d: Drill) => void }) {
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const [selected, setSelected] = useState('all')

  const alerts = useMemo(() => {
    const out: Alert[] = []
    const want = (k: string) => selected === 'all' || selected === k
    if (want('frog')) for (const v of data.boilingFrog.accounts) out.push({ detector: 'frog', label: 'Boiling Frog', item: v.accountName, severity: v.totalCreep > 20 ? 'High' : 'Medium', impact: v.annualizedCreep, details: `+${v.avgMonthlyIncrease.toFixed(1)}%/mo for ${v.monthCount} months`, accountId: v.accountId })
    if (want('anomaly')) for (const a of data.anomalies.items) out.push({ detector: 'anomaly', label: 'Anomaly', item: a.accountName, severity: a.zScore > 3 ? 'Critical' : 'High', impact: a.amount, details: `${a.zScore.toFixed(1)}σ from mean in ${a.month}`, accountId: a.accountId })
    if (want('zombie')) for (const z of data.zombies.subscriptions) out.push({ detector: 'zombie', label: 'Zombie', item: z.vendorName, severity: 'Medium', impact: z.annualCost, details: `${money0(z.amount)}/mo unchanged for ${z.monthCount} months`, vendorId: z.vendorId })
    if (want('concentration')) for (const c of data.concentration.accounts) out.push({ detector: 'concentration', label: 'Concentration', item: c.name, severity: c.spendShare > 30 ? 'High' : 'Medium', impact: c.totalSpend, details: `${c.spendShare.toFixed(1)}% of spend, ${c.trend}`, accountId: c.id })
    if (want('fragmentation')) for (const f of data.fragmentation.categories) out.push({ detector: 'fragmentation', label: 'Fragmentation', item: f.accountName, severity: f.txnsPerMonth > 50 ? 'High' : 'Medium', impact: f.totalSpend, details: `${f.txnsPerMonth} txns/mo, avg ${money0(f.avgTransactionSize)}`, accountId: f.accountId })
    if (want('seasonal')) for (const p of data.seasonal.patterns.filter((x) => x.isHigh || x.isLow)) out.push({ detector: 'seasonal', label: 'Seasonal', item: p.monthName, severity: Math.abs(p.deviation) > 50 ? 'High' : 'Low', impact: p.totalSpend, details: `${p.deviation > 0 ? '+' : ''}${p.deviation}% vs average month` })
    if (want('cliff') && data.commitmentCliff.summary.status !== 'healthy') {
      const c = data.commitmentCliff.summary
      out.push({ detector: 'cliff', label: 'Commit. Cliff', item: 'PO vs SO velocity', severity: c.status === 'critical' ? 'Critical' : 'High', impact: c.totalPO, details: `gap ${c.velocityGap}%, ratio ${c.ratio}×` })
    }
    return out.sort((a, b) => b.impact - a.impact)
  }, [data, selected])

  const total = data.summary.totalAlerts
  return (
    <div className="space-y-5">
      <p className={cn('flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm', total > 5 ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300' : total > 0 ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400')}>
        {total > 0 ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
        <span><span className="font-bold">{total} total alerts</span> across 8 detectors — click a card to filter</span>
      </p>
      <DetectorGrid data={data} selected={selected} onSelect={setSelected} />
      <Panel title="Alert Details" icon={Search} actions={selected !== 'all' ? (
        <button type="button" onClick={() => setSelected('all')} className="text-xs text-teal-600 hover:underline dark:text-teal-400">Clear filter · {selected}</button>
      ) : undefined} bodyClassName="p-0">
        <div className="max-h-104 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Detector</th>
                <th className="px-4 py-2 text-left font-medium">Item</th>
                <th className="px-4 py-2 text-center font-medium">Severity</th>
                <th className="px-4 py-2 text-right font-medium">Impact</th>
                <th className="px-4 py-2 text-left font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length ? alerts.map((a, i) => (
                <tr
                  key={i}
                  onClick={a.accountId ? () => onDrill({ kind: 'account', id: a.accountId!, name: a.item }) : a.vendorId ? () => onDrill({ kind: 'vendor', id: a.vendorId!, name: a.item }) : undefined}
                  className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', (a.accountId || a.vendorId) && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40')}
                >
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{a.label}</td>
                  <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-200">{a.item}</td>
                  <td className="px-4 py-2 text-center">
                    <Badge variant={a.severity === 'Critical' ? 'destructive' : a.severity === 'High' ? 'warning' : 'secondary'}>{a.severity}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(a.impact)}</td>
                  <td className="px-4 py-2 text-xs text-slate-400 dark:text-slate-500">{a.details}</td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />No alerts detected{selected !== 'all' ? ' for this detector' : ''}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span><span className="font-semibold">Shadow IT</span> is unavailable in openbooks: {data.shadowIT.reason}</span>
      </p>
    </div>
  )
}

/* ---------------------------------------------------------------- Accounts */

type AcctFilter = 'all' | 'increases' | 'decreases' | 'highvel' | 'new'

function AccountsTab({ data, onDrill }: { data: SpendVelocityData; onDrill: (d: Drill) => void }) {
  const today = useBusinessToday()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const cmp = data.periodComparison
  const [filter, setFilter] = useState<AcctFilter>('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('currentAmount')

  const rows = useMemo(() => {
    let list = cmp.accounts
    if (filter === 'increases') list = list.filter((a) => a.changePct > 5)
    else if (filter === 'decreases') list = list.filter((a) => a.changePct < -5)
    else if (filter === 'highvel') list = list.filter((a) => Math.abs(a.velocity) > 10)
    else if (filter === 'new') list = list.filter((a) => a.isNew)
    if (search) list = list.filter((a) => a.accountName.toLowerCase().includes(search.toLowerCase()))
    return [...list].sort((a, b) => Math.abs((b as any)[sortBy] ?? 0) - Math.abs((a as any)[sortBy] ?? 0))
  }, [cmp.accounts, filter, search, sortBy])

  const chips: { key: AcctFilter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'increases', label: '↑ Increases' }, { key: 'decreases', label: '↓ Decreases' },
    { key: 'highvel', label: '🔥 High Vel' }, { key: 'new', label: '+ New' },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={CalendarRange} accent="sky" label="Current Period" value={money(cmp.summary.currentTotal)} sub={data.period.label} />
        <KpiCard icon={CalendarRange} accent="slate" label="Prior Period" value={money(cmp.summary.priorTotal)} sub={`${cmp.summary.changePct > 0 ? '↑' : '↓'} ${Math.abs(cmp.summary.changePct).toFixed(1)}%`} tone={cmp.summary.changePct > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={CalendarRange} accent="slate" label="2 Periods Back" value={money(cmp.summary.twoBackTotal)} sub={cmp.summary.twoBackLabel} />
        <KpiCard icon={TrendingUp} accent="violet" label="Projected Next" value={money(cmp.summary.projectedTotal)} sub="based on trend" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search accounts…" className="h-8 w-52 rounded-md border border-slate-200 bg-white pl-8 pr-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button key={c.key} type="button" onClick={() => setFilter(c.key)} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', filter === c.key ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400')}>{c.label}</button>
          ))}
        </div>
        <div className="ml-auto">
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="w-40" triggerClassName="h-8 text-sm">
            <option value="currentAmount">Sort: Spend</option>
            <option value="velocity">Sort: Velocity</option>
            <option value="changePct">Sort: Change %</option>
            <option value="acceleration">Sort: Accel</option>
          </Select>
        </div>
      </div>

      <Panel
        title="Account Deep Analysis"
        icon={Layers}
        hint={`${rows.length} accounts · click a row for transactions`}
        bodyClassName="p-0"
        actions={
          <button
            type="button"
            onClick={() => exportCsv('spend-accounts', ['Account', 'Current', 'Prior', '2 Back', 'Change %', 'Projected', 'Velocity %/mo', 'Accel', 'Trend'], rows.map((a) => [a.accountName, Math.round(a.currentAmount), Math.round(a.priorAmount), Math.round(a.twoBackAmount), a.changePct.toFixed(1), Math.round(a.projectedAmount), a.velocity.toFixed(1), a.acceleration.toFixed(1), a.trend])), today)}
            className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <Download size={11} /> CSV
          </button>
        }
      >
        <div className="max-h-128 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Account</th>
                <th className="px-4 py-2 text-right font-medium">Current</th>
                <th className="px-4 py-2 text-right font-medium">Prior</th>
                <th className="px-4 py-2 text-right font-medium">Change</th>
                <th className="px-4 py-2 text-right font-medium">Velocity</th>
                <th className="px-4 py-2 text-right font-medium">Projected</th>
                <th className="px-4 py-2 text-left font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.accountId} onClick={() => onDrill({ kind: 'account', id: a.accountId, name: a.accountName })} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-200">
                    {a.accountName}
                    {a.isNew ? <span className="ml-2 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-400">NEW</span> : null}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(a.currentAmount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">{money0(a.priorAmount)}</td>
                  <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', a.changePct > 0 ? 'text-rose-600 dark:text-rose-400' : a.changePct < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400')}>
                    {a.changePct > 0 ? '+' : ''}{pct1(a.changePct)}
                  </td>
                  <td className="px-4 py-2 text-right"><VelocityPill v={a.velocity} /></td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money0(a.projectedAmount)}</td>
                  <td className="px-4 py-2"><Spark values={a.monthlyTrend} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------------- Expenses */


/* ------------------------------------------------------------------ Trends */

function TrendsTab({ data }: { data: SpendVelocityData }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const t = data.monthlyTrends
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Monthly Spend Velocity" icon={ChartArea} hint="Current vs same month prior year">
            <Chart
              height={300}
              option={{
                grid: { top: 26, bottom: 26, left: 62, right: 14 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => (v == null ? '—' : money0(Number(v))) },
                xAxis: { type: 'category', data: t.map((m) => m.month) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => money(v) } },
                series: [
                  { name: 'Spend', type: 'line', areaStyle: { opacity: 0.15 }, data: t.map((m) => m.totalAmount), lineStyle: { width: 2, color: '#6366f1' }, itemStyle: { color: '#6366f1' } },
                  { name: 'Prior Year', type: 'line', data: t.map((m) => m.priorYearAmount || null), lineStyle: { width: 1.5, type: 'dashed', color: '#94a3b8' }, itemStyle: { color: '#94a3b8' } },
                ],
              }}
            />
          </Panel>
        </div>
        <Panel title="Seasonal Patterns" icon={Snowflake}>
          {data.seasonal.insights.length ? (
            <ul className="mb-3 space-y-1.5 text-sm">
              {data.seasonal.insights.map((i, k) => (
                <li key={k} className="flex items-start gap-2 text-slate-600 dark:text-slate-300">
                  {i.type === 'high_season' ? <TrendingUp size={14} className="mt-0.5 shrink-0 text-rose-500" /> : <TrendingDown size={14} className="mt-0.5 shrink-0 text-emerald-500" />}
                  {i.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-slate-400">No significant seasonal patterns detected</p>
          )}
          <p className="mb-1.5 text-xs text-slate-400 dark:text-slate-500">Monthly deviation from average</p>
          <div className="space-y-1">
            {data.seasonal.patterns.map((p) => (
              <div key={p.month} className="flex items-center gap-2 text-xs">
                <span className="w-7 text-slate-500 dark:text-slate-400">{p.monthName}</span>
                <div className="relative h-3 flex-1 rounded bg-slate-100 dark:bg-slate-800">
                  <div
                    className="absolute top-0 h-full rounded"
                    style={{
                      width: `${Math.min(Math.abs(p.deviation), 50)}%`,
                      backgroundColor: p.deviation > 0 ? '#ef4444' : '#10b981',
                      ...(p.deviation > 0 ? { left: '50%' } : { right: '50%' }),
                    }}
                  />
                  <div className="absolute inset-y-0 left-1/2 w-px bg-slate-300 dark:bg-slate-600" />
                </div>
                <span className="w-10 text-right tabular-nums text-slate-500 dark:text-slate-400">{p.deviation > 0 ? '+' : ''}{p.deviation}%</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Monthly Summary" icon={BarChart3} bodyClassName="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Month</th>
              <th className="px-4 py-2 text-right font-medium">Total Spend</th>
              <th className="px-4 py-2 text-right font-medium">Prior Year</th>
              <th className="px-4 py-2 text-right font-medium">YoY Change</th>
              <th className="px-4 py-2 text-right font-medium">Velocity</th>
              <th className="px-4 py-2 text-right font-medium">Txns</th>
              <th className="px-4 py-2 text-right font-medium">Vendors</th>
            </tr>
          </thead>
          <tbody>
            {t.map((m) => (
              <tr key={m.month} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2 font-medium tabular-nums text-slate-800 dark:text-slate-200">{m.month}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(m.totalAmount)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-400">{m.priorYearAmount ? money0(m.priorYearAmount) : '—'}</td>
                <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', m.yoyChange > 0 ? 'text-rose-600 dark:text-rose-400' : m.yoyChange < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400')}>{m.priorYearAmount ? `${m.yoyChange > 0 ? '+' : ''}${pct1(m.yoyChange)}` : '—'}</td>
                <td className="px-4 py-2 text-right"><VelocityPill v={m.velocity} /></td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-400">{m.transactionCount.toLocaleString('en-US')}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-400">{m.vendorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

/* ----------------------------------------------------------- Configuration */

function ConfigTab({ data }: { data: SpendVelocityData }) {
  const fmtMoney = useAnalyticsMoney()
  const c = data.config
  const items = [
    { label: 'Velocity thresholds', value: `${c.velocityMediumThreshold}% / ${c.velocityHighThreshold}%`, note: 'Rising / high monthly CAGR cutoffs' },
    { label: 'Anomaly threshold', value: `${c.anomalyStdDevThreshold}σ`, note: 'Z-score for statistical outliers (critical at 3σ)' },
    { label: 'Boiling frog', value: `${c.boilingFrogMonths} months`, note: 'Minimum months of small (<10%) monotonic increases' },
    { label: 'Zombie window', value: `${c.zombieMinMonths} months`, note: 'Identical recurring vendor totals (<1% deviation)' },
    { label: 'Fragmentation', value: `>${c.fragmentationMinTxns}/mo & <${fmtMoney(c.fragmentationMaxAvgSize)}`, note: 'Transactions per month / avg transaction size' },
    { label: 'Velocity engine', value: 'Monthly CAGR', note: `(end/start)^(1/periods) − 1 with ${fmtMoney(c.minBaseAmount)} minimum base` },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="spendVelocity"
          fields={[
            { key: 'velocityHighThreshold', label: 'High velocity (%/mo)', help: 'Monthly CAGR above this classifies as accelerating/high', min: 1, max: 100, step: 1 },
            { key: 'velocityMediumThreshold', label: 'Medium velocity (%/mo)', help: 'Monthly CAGR above this classifies as rising', min: 0, max: 50, step: 1 },
            { key: 'anomalyStdDevThreshold', label: 'Anomaly σ', help: 'Months beyond this many standard deviations flag as anomalies', min: 1, max: 6, step: 0.1 },
            { key: 'boilingFrogMonths', label: 'Boiling frog months', help: 'Minimum months of sustained small increases', min: 3, max: 24, step: 1 },
            { key: 'zombieMinMonths', label: 'Zombie months', help: 'Identical monthly vendor totals for at least this many months', min: 3, max: 24, step: 1 },
            { key: 'fragmentationMinTxns', label: 'Fragmentation txns/mo', help: 'Monthly transaction count above this (below the size cap) flags fragmentation', min: 5, max: 500, step: 5 },
            { key: 'fragmentationMaxAvgSize', label: 'Fragmentation average size', help: 'Average transaction size cap for the fragmentation detector', min: 50, max: 10_000, step: 50 },
          ]}
          values={c as unknown as Record<string, number>}
          defaults={{ velocityHighThreshold: 15, velocityMediumThreshold: 5, anomalyStdDevThreshold: 2.5, boilingFrogMonths: 6, zombieMinMonths: 6, fragmentationMinTxns: 20, fragmentationMaxAvgSize: 500 }}
        />
        <Panel title="Model & Thresholds" icon={SlidersHorizontal} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {items.map((i) => (
              <li key={i.label} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{i.label}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{i.value}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel title="Data sources" icon={Info}>
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>Spend = expense/COGS journal lines from the four spend document types:</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-500 dark:text-slate-400">
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Vendor bills, expense reports, checks</span> add to spend; <span className="font-medium text-slate-700 dark:text-slate-200">vendor credits</span> net against it.</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Commitment cliff</span> compares purchase-order vs sales-order monthly velocity.</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Revenue normalisation</span> uses GL income for the OpEx ratio ({data.revenue.opexRatio}%).</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Shadow IT</span> — unavailable: {data.shadowIT.reason}</li>
          </ul>
          <p>Drill-downs fetch that account or vendor&apos;s full activity for the period on click (searchable, with monthly trend and breakdown); each row links to the real record in its native module.</p>
        </div>
      </Panel>
    </div>
  )
}
