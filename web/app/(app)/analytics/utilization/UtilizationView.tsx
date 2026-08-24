'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle, ArrowDown, ArrowRightLeft, BarChart3, Box, Brain, Building2, Calculator,
  ChartArea, CheckCircle2, Clock, DollarSign, Info, Lightbulb, PieChart as PieIcon,
  Scale, Search, SlidersHorizontal, Table2, Target, TrendingDown, TrendingUp, Trophy,
  UserPlus, UserRound, Users, LayoutGrid, Grid3X3,
} from 'lucide-react'
import { cn, Select, Drawer, Badge } from '@openbooks/ui'
import type { UtilizationData, UGroupRow, UStat } from '../../../../lib/analytics/utilization-data'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { Donut, Chart } from '../_ui/charts'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { useSort } from '../_ui/useSort'
import { useAnalyticsMoney } from '../_ui/format'

/* ------------------------------------------------------------------ helpers */

const TABS = ['overview', 'intelligence', 'departments', 'items', 'titles', 'employees', 'config'] as const
type Tab = (typeof TABS)[number]
const pct1 = (v: number | null | undefined, d = 1) => (v == null || isNaN(v) ? '—' : `${Number(v).toFixed(d)}%`)
const hrs0 = (n: number) => `${Math.round(n).toLocaleString('en-US')}`

/** Status colouring vs target: on / near (−10) / below. */
function statusTone(pct: number, target: number) {
  if (pct >= target) return { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500', hex: '#10b981' }
  if (pct >= target - 10) return { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500', hex: '#f59e0b' }
  return { text: 'text-rose-600 dark:text-rose-400', bar: 'bg-rose-500', hex: '#ef4444' }
}

/** Trend chip: delta in pp, $ or plain hours — green when moving the good way. */
function TrendDelta({ delta, goodIfUp, unit = 'pp', digits = 1 }: { delta: number; goodIfUp: boolean; unit?: 'pp' | 'money' | 'hours'; digits?: number }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  if (!delta || Math.abs(delta) < (unit === 'pp' ? 0.05 : 0.5)) return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
  const good = goodIfUp ? delta > 0 : delta < 0
  const Icon = delta > 0 ? TrendingUp : TrendingDown
  const text = unit === 'money' ? money(Math.abs(delta)) : unit === 'hours' ? `${hrs0(Math.abs(delta))}h` : `${Math.abs(delta).toFixed(digits)}pp`
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold tabular-nums', good ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
      <Icon size={12} />
      {text}
    </span>
  )
}

/** the risk-meter billable gauge (semicircle arc coloured vs target). */
function BillableGauge({ pct, target }: { pct: number; target: number }) {
  const t = useTranslations('analytics.utilization')
  const diff = pct - target
  const color = diff >= 0 ? '#10b981' : diff >= -10 ? '#f59e0b' : diff >= -20 ? '#f97316' : '#ef4444'
  const label = diff >= 0 ? t('gauge.onTarget') : diff >= -10 ? t('gauge.nearTarget') : diff >= -20 ? t('gauge.belowTarget') : t('gauge.atRisk')
  const arcLength = 141.37
  const offset = arcLength * (1 - Math.min(pct, 100) / 100)
  return (
    <div className="flex h-full items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <svg width="92" height="52" viewBox="0 0 100 55" className="shrink-0">
        <path d="M 5 50 A 45 45 0 0 1 95 50" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" className="text-slate-200 dark:text-slate-700" />
        <path d="M 5 50 A 45 45 0 0 1 95 50" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={arcLength} strokeDashoffset={offset} style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <div className="min-w-0">
        <p className="text-xl font-bold tabular-nums" style={{ color }}>{pct1(pct)}</p>
        <p className="text-[10px] font-bold tracking-wider" style={{ color }}>{label}</p>
        <p className="text-[10px] text-slate-400 dark:text-slate-500">{t('gauge.targetPct', { target })}</p>
      </div>
    </div>
  )
}

/** Tiny SVG sparkline for department cards (history % billed). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values), max = Math.max(...values)
  const pad = (max - min) * 0.3 || 5
  const lo = Math.max(0, min - pad), hi = max + pad
  const w = 120, h = 28
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - lo) / (hi - lo)) * h}`).join(' ')
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-2">
      <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="1.5" />
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill="#6366f1" opacity="0.08" />
    </svg>
  )
}

/** Treemap pastel scale (soft red → orange → yellow → mint → green). */
function treemapColor(pct: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [254, 202, 202]], [25, [254, 215, 170]], [50, [254, 240, 138]], [75, [187, 247, 208]], [100, [134, 239, 172]],
  ]
  const p = Math.max(0, Math.min(100, pct))
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i]![0]) {
      const [p0, c0] = stops[i - 1]!, [p1, c1] = stops[i]!
      const t = (p - p0) / (p1 - p0)
      const c = c0.map((v: number, j: number) => Math.round(v + (c1[j]! - v) * t))
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
  }
  return 'rgb(134,239,172)'
}

/* ---------------------------------------------------------- entries drawer */

interface Entry {
  id: string; date: string; hours: number; billable: boolean; cost: number
  itemName: string; employeeName: string; customerName: string; memo: string
}

/** Native Drawer listing raw time entries behind an employee / item drill. */
function EntriesDrawer({ kind, id, name, sub, peer, from, to, onClose }: {
  kind: 'employee' | 'item'; id: string; name: string; sub?: string; peer?: { title: string; empPct: number; peerAvg: number; peerCount: number }; from: string; to: string; onClose: () => void
}) {
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const t = useTranslations('analytics.utilization')
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState(false)
  const [view, setView] = useState<'entries' | 'byItem' | 'byCustomer'>('entries')
  useEffect(() => {
    let live = true
    setEntries(null); setError(false); setView('entries')
    fetch(`/api/analytics/utilization/entries?${kind}=${encodeURIComponent(id)}&from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (live) setEntries(j.entries) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [kind, id, from, to])

  const total = (entries ?? []).reduce((a, e) => a + e.hours, 0)
  const billable = (entries ?? []).reduce((a, e) => a + (e.billable ? e.hours : 0), 0)

  // Group entries by a key → { hours, billable }.
  const groupBy = (keyFn: (e: Entry) => string) => {
    const m = new Map<string, { hours: number; billable: number }>()
    for (const e of entries ?? []) {
      const k = keyFn(e) || '—'
      const g = m.get(k) ?? { hours: 0, billable: 0 }
      g.hours += e.hours; g.billable += e.billable ? e.hours : 0
      m.set(k, g)
    }
    return [...m.entries()].map(([label, g]) => ({ label, ...g })).sort((a, b) => b.hours - a.hours)
  }
  const itemGroups = view === 'byItem' ? groupBy((e) => (kind === 'employee' ? e.itemName : e.employeeName)) : []
  const custGroups = view === 'byCustomer' ? groupBy((e) => e.customerName) : []

  return (
    <Drawer open onClose={onClose} size="lg" title={name} description={sub ?? t('entries.title')} bodyClassName="overflow-hidden flex flex-col p-0">
      {/* Peer strip (employee vs same-title average) */}
      {peer ? (
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-800/30">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{t('entries.peers', { title: peer.title, count: peer.peerCount })}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('entries.thisVsPeer', { emp: pct1(peer.empPct), peer: pct1(peer.peerAvg) })}</p>
          </div>
          <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', peer.empPct >= peer.peerAvg ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300')}>
            {peer.empPct >= peer.peerAvg ? '+' : ''}{(peer.empPct - peer.peerAvg).toFixed(1)}pp
          </span>
        </div>
      ) : null}

      <div className="flex items-center gap-4 border-b border-slate-100 px-4 py-2.5 text-sm dark:border-slate-800">
        <span className="text-slate-500 dark:text-slate-400">{entries ? t('entries.count', { count: entries.length, suffix: entries.length === 500 ? '+' : '' }) : '…'}</span>
        <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{t('entries.hrs', { hours: hrs0(total) })}</span>
        <span className="tabular-nums text-emerald-600 dark:text-emerald-400">{total > 0 ? t('entries.billableOf', { pct: pct1((billable / total) * 100) }) : '—'}</span>
      </div>

      {/* View pills */}
      <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
        {([['entries', t('entries.pills.entries')], ['byItem', kind === 'employee' ? t('entries.pills.byItem') : t('entries.pills.byEmployee')], ['byCustomer', t('entries.pills.byCustomer')]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', view === k ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400')}>{label}</button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('error.loadFailed')}</p>
        ) : !entries ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('loading')}</p>
        ) : view !== 'entries' ? (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{view === 'byItem' ? (kind === 'employee' ? t('entries.serviceItem') : t('entries.employee')) : t('table.customer')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.hours')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.billablePct')}</th>
                <th className="w-32 px-4 py-2 text-left font-medium">{t('table.share')}</th>
              </tr>
            </thead>
            <tbody>
              {(view === 'byItem' ? itemGroups : custGroups).map((g) => (
                <tr key={g.label} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="max-w-48 truncate px-4 py-2 text-slate-700 dark:text-slate-300" title={g.label}>{g.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{g.hours.toFixed(1)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{g.hours > 0 ? pct1((g.billable / g.hours) * 100) : '—'}</td>
                  <td className="px-4 py-2"><span className="block h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><span className="block h-full rounded-full bg-teal-400" style={{ width: `${total > 0 ? (g.hours / total) * 100 : 0}%` }} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.date')}</th>
                <th className="px-4 py-2 text-left font-medium">{kind === 'employee' ? t('entries.item') : t('entries.employee')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('table.customer')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.hours')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.billable')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-1.5 whitespace-nowrap tabular-nums text-slate-500 dark:text-slate-400">{e.date}</td>
                  <td className="max-w-40 truncate px-4 py-1.5 text-slate-700 dark:text-slate-300" title={kind === 'employee' ? e.itemName : e.employeeName}>{kind === 'employee' ? e.itemName : e.employeeName}</td>
                  <td className="max-w-40 truncate px-4 py-1.5 text-slate-500 dark:text-slate-400" title={e.customerName}>{e.customerName || '—'}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums text-slate-800 dark:text-slate-200">{e.hours.toFixed(1)}</td>
                  <td className="px-4 py-1.5 text-center">
                    {e.billable
                      ? <Badge variant="success">{t('yes')}</Badge>
                      : <span className="text-xs text-rose-500 tabular-nums">{e.cost > 0 ? money0(e.cost) : t('no')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Drawer>
  )
}

type Flyout = { kind: 'employee' | 'item'; id: string; name: string; sub?: string; peer?: { title: string; empPct: number; peerAvg: number; peerCount: number } } | null

/* ------------------------------------------------------------------- shell */

export function UtilizationView({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [tab, setTab] = useState<Tab>('overview')
  const [flyout, setFlyout] = useState<Flyout>(null)
  const target = data.config.target
  const c = data.company.range

  return (
    <div className="space-y-5">
      {/* Hero row: gauge + 4 KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <BillableGauge pct={c.percentBilled} target={target} />
        <KpiCard icon={DollarSign} accent="red" label={t('kpi.nonBillableCost')} value={money(c.nonBillableCost)} sub={t('sub.totalForRange')} tone="negative" />
        <KpiCard icon={Clock} accent="slate" label={t('kpi.costPerDay')} value={money(c.nonBillableCostPerDay)} sub={t('sub.daysInRange', { days: data.period.days })} />
        <KpiCard icon={UserRound} accent="violet" label={t('kpi.totalHours')} value={hrs0(c.hours)} sub={t('sub.recordedTime')} />
        <KpiCard icon={CheckCircle2} accent="emerald" label={t('kpi.billableHours')} value={hrs0(c.billableHours)} sub={t('sub.revenueGenerating')} tone="positive" />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {t(`tabs.${k}`)}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'intelligence' ? <IntelligenceTab data={data} /> : null}
        {tab === 'departments' ? <DepartmentsTab data={data} /> : null}
        {tab === 'items' ? <ItemsTab data={data} onDrill={setFlyout} /> : null}
        {tab === 'titles' ? <TitlesTab data={data} /> : null}
        {tab === 'employees' ? <EmployeesTab data={data} onDrill={setFlyout} /> : null}
        {tab === 'config' ? <ConfigTab data={data} /> : null}
      </div>

      {flyout ? (
        <EntriesDrawer kind={flyout.kind} id={flyout.id} name={flyout.name} sub={flyout.sub} peer={flyout.peer} from={data.period.from} to={data.period.to} onClose={() => setFlyout(null)} />
      ) : null}
    </div>
  )
}

/** Employees/depts visible to Intelligence: exclude no-billable departments. */
function intelligenceScope(data: UtilizationData) {
  const noBill = new Set(data.departments.filter((d) => d.noBillable).map((d) => d.id))
  return {
    depts: data.departments.filter((d) => !d.noBillable),
    employees: data.employees.filter((e) => !e.departmentId || !noBill.has(e.departmentId)),
  }
}

/* ---------------------------------------------------------------- Overview */

function OverviewTab({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const target = data.config.target
  const c = data.company.range
  const p = data.company.prior
  const d = data.company.deltas

  const rows: [string, string, string, React.ReactNode][] = [
    [t('metric.percentBilled'), pct1(c.percentBilled), pct1(p.percentBilled), <TrendDelta key="1" delta={d.pctDelta} goodIfUp />],
    [t('metric.nonBillableCost'), money0(c.nonBillableCost), money0(p.nonBillableCost), <TrendDelta key="2" delta={d.costDelta} goodIfUp={false} unit="money" />],
    [t('metric.totalHours'), hrs0(c.hours), hrs0(p.hours), <TrendDelta key="3" delta={c.hours - p.hours} goodIfUp unit="hours" />],
    [t('metric.billableHours'), hrs0(c.billableHours), hrs0(p.billableHours), <TrendDelta key="4" delta={c.billableHours - p.billableHours} goodIfUp unit="hours" />],
    [t('metric.nonBillableHours'), hrs0(c.nonBillableHours), hrs0(p.nonBillableHours), <TrendDelta key="5" delta={c.nonBillableHours - p.nonBillableHours} goodIfUp={false} unit="hours" />],
    [t('metric.costPerDay'), money0(c.nonBillableCostPerDay), money0(p.nonBillableCostPerDay), '—'],
  ]

  // Cost hotspots (exclude no-billable departments, ).
  const billableDepts = data.departments.filter((x) => !x.noBillable)
  const topDept = billableDepts[0]
  const topItem = data.items[0]
  const noBillIds = new Set(data.departments.filter((x) => x.noBillable).map((x) => x.id))
  const qualified = data.employees
    .filter((e) => e.meetsMinHours && (!e.departmentId || !noBillIds.has(e.departmentId)))
    .sort((a, b) => a.range.percentBilled - b.range.percentBilled)
  const lowEmp = qualified[0]
  const sameRate = lowEmp ? qualified.filter((e) => Math.round(e.range.percentBilled) === Math.round(lowEmp.range.percentBilled)).length : 0

  // Top departments by non-billable cost, coloured vs target.
  const topDepts = billableDepts.slice(0, 5)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Panel title={t('panels.efficiencySummary')} icon={Scale} bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.metric')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.currentRange')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.priorRange')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.change')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, cur, pri, trend]) => (
                  <tr key={label} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5 font-medium text-slate-700 dark:text-slate-300">{label}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-200">{cur}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-400 dark:text-slate-500">{pri}</td>
                    <td className="px-4 py-2.5 text-right">{trend}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Panel title={t('panels.hoursDistribution')} icon={PieIcon}>
              <Donut
                data={[{ name: t('chart.billable'), value: c.billableHours }, { name: t('chart.nonBillable'), value: c.nonBillableHours }]}
                height={200}
                valueFormat={(v) => `${Math.round(v).toLocaleString()} ${t('unit.hrs')}`}
                colors={['#10b981', '#ef4444']}
              />
            </Panel>
            <Panel title={t('panels.topDepartments')} hint={t('panels.topDepartmentsHint')}>
              <div className="space-y-2.5">
                {topDepts.map((x) => {
                  const tone = statusTone(x.range.percentBilled, target)
                  const max = topDepts[0]?.range.nonBillableCost || 1
                  return (
                    <div key={x.id}>
                      <div className="mb-0.5 flex justify-between text-xs">
                        <span className="truncate text-slate-600 dark:text-slate-300">{x.name}</span>
                        <span className="tabular-nums text-slate-500 dark:text-slate-400">{money(x.range.nonBillableCost)} · <span className={tone.text}>{pct1(x.range.percentBilled, 0)}</span></span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${Math.max(2, (x.range.nonBillableCost / max) * 100)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Panel>
          </div>
        </div>
        <div className="space-y-5 lg:col-span-2">
          <Panel title={t('panels.alerts')} icon={AlertTriangle}>
            {data.company.alerts.length ? (
              <ul className="space-y-2 text-sm">
                {data.company.alerts.map((a, i) => (
                  <li key={i} className={cn('flex items-start gap-2', a.type === 'danger' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-700 dark:text-amber-300')}>
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    {a.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={15} />{t('empty.allWithinTarget')}</p>
            )}
          </Panel>
          <Panel title={t('panels.costHotspots')} icon={Target} bodyClassName="p-0">
            <ul className="divide-y divide-slate-50 text-sm dark:divide-slate-800/60">
              <li className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-slate-500 dark:text-slate-400">{t('hotspot.mostExpensiveDept')}</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{topDept?.name ?? '—'}</span>
              </li>
              <li className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-slate-500 dark:text-slate-400">{t('hotspot.highestCostItem')}</span>
                <span className="max-w-52 truncate font-semibold text-slate-800 dark:text-slate-200" title={topItem?.name}>{topItem?.name ?? '—'}</span>
              </li>
              <li className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-slate-500 dark:text-slate-400">{t('hotspot.lowestBilledEmp')}</span>
                <span className="text-right font-semibold text-slate-800 dark:text-slate-200">
                  {lowEmp ? `${lowEmp.name} (${Math.round(lowEmp.range.percentBilled)}%)` : '—'}
                  {sameRate > 1 ? <span className="ml-1 font-normal text-slate-400">{t('hotspot.others', { count: sameRate - 1 })}</span> : null}
                </span>
              </li>
            </ul>
          </Panel>
          <Panel title={t('panels.noBillableExpectation')} icon={Info}>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {data.departments.filter((x) => x.noBillable).map((x) => x.name).join(', ') || t('none')} — {t('noBillableNote')}
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ Intelligence */

const SUB_TABS = ['forecasting', 'anomalies', 'peers', 'whatif', 'treemap'] as const
type SubTab = (typeof SUB_TABS)[number]
const SUB_ICON: Record<SubTab, typeof ChartArea> = {
  forecasting: ChartArea, anomalies: AlertTriangle, peers: Scale, whatif: Calculator, treemap: LayoutGrid,
}

function IntelligenceTab({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const [sub, setSub] = useState<SubTab>('forecasting')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {SUB_TABS.map((k) => {
          const Icon = SUB_ICON[k]
          return (
            <button key={k} type="button" onClick={() => setSub(k)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors', sub === k ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800')}>
              <Icon size={13} />{t(`subTabs.${k}`)}
            </button>
          )
        })}
      </div>
      <div key={sub}>
        {sub === 'forecasting' ? <ForecastingSub data={data} /> : null}
        {sub === 'anomalies' ? <AnomaliesSub data={data} /> : null}
        {sub === 'peers' ? <PeersSub data={data} /> : null}
        {sub === 'whatif' ? <WhatIfSub data={data} /> : null}
        {sub === 'treemap' ? <TreemapSub data={data} /> : null}
      </div>
    </div>
  )
}

/** : linear regression on history + inverse cost. */
function useForecasts(data: UtilizationData) {
  return useMemo(() => {
    const range = data.company.range
    const series = data.history.periods.map((p) => p.companyPct).reverse()
    series.push(range.percentBilled)

    const forecast = (s: number[]) => {
      if (s.length < 2) return { projected: s[s.length - 1] || 0, trend: 0 }
      const n = s.length
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
      for (let i = 0; i < n; i++) { sumX += i; sumY += s[i]!; sumXY += i * s[i]!; sumXX += i * i }
      const denom = n * sumXX - sumX * sumX
      if (denom === 0) return { projected: s[s.length - 1] || 0, trend: 0 }
      const slope = (n * sumXY - sumX * sumY) / denom
      const intercept = (sumY - slope * sumX) / n
      return { projected: Math.max(0, intercept + slope * n), trend: slope }
    }
    const f = forecast(series)
    const projectedBillable = Math.min(100, Math.max(0, f.projected))

    // Cost projection — inverse to billable %, including the ~100% edge case.
    const currentCost = range.nonBillableCost
    const currentNonBillPct = 100 - range.percentBilled
    const projectedNonBillPct = 100 - projectedBillable
    let projectedCost = currentCost
    if (currentNonBillPct <= 0.01) {
      if (projectedNonBillPct > 0.01) {
        const avgCostPerHour = range.nonBillableHours > 0 && currentCost > 0 ? currentCost / range.nonBillableHours : range.nonBillableCostPerHour || 50
        projectedCost = range.hours * (projectedNonBillPct / 100) * avgCostPerHour
      } else projectedCost = 0
    } else {
      projectedCost = currentCost * (projectedNonBillPct / currentNonBillPct)
    }
    projectedCost = Math.max(0, Math.min(currentCost * 2, projectedCost))

    const mean = series.reduce((a, b) => a + b, 0) / series.length
    const variance = Math.sqrt(series.map((v) => (v - mean) ** 2).reduce((a, b) => a + b, 0) / series.length)
    const confidence = Math.round(Math.max(30, Math.min(95, 100 - variance)))

    return { series, projectedBillable, billableTrend: f.trend, projectedCost, costTrend: projectedCost - currentCost, confidence, dataPoints: series.length }
  }, [data])
}

function ForecastingSub({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const target = data.config.target
  const f = useForecasts(data)
  const labels = [...data.history.periods.map((p) => p.label).reverse(), t('forecast.current'), t('forecast.projected')]
  const hist = [...f.series, null]
  const proj = [...f.series.slice(0, -1).map(() => null), f.series[f.series.length - 1], f.projectedBillable]

  const tone = f.projectedBillable >= target ? 'positive' : 'negative'
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={ChartArea} accent="sky" label={t('kpi.projectedBillablePct')} value={pct1(f.projectedBillable)} sub={t('sub.trendArrow', { arrow: f.billableTrend >= 0 ? '↑' : '↓', trend: Math.abs(f.billableTrend).toFixed(1) })} tone={(tone)} />
        <KpiCard icon={DollarSign} accent={f.costTrend <= 0 ? 'emerald' : 'red'} label={t('kpi.projectedNonBillCost')} value={money(f.projectedCost)} sub={t('sub.trajectory', { arrow: f.costTrend <= 0 ? '↓' : '↑', amount: money(Math.abs(f.costTrend)) })} tone={f.costTrend <= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Target} accent="violet" label={t('kpi.targetStatus')} value={f.projectedBillable >= target ? t('forecast.onTrack') : t('forecast.atRisk')} sub={t('sub.targetPct', { target })} tone={(tone)} />
        <KpiCard icon={Brain} accent="slate" label={t('kpi.confidence')} value={`${f.confidence}%`} sub={t('sub.dataPoints', { count: f.dataPoints })} />
      </div>
      <Panel title={t('panels.forecastTrend')} icon={ChartArea}>
        <Chart
          height={280}
          option={{
            grid: { top: 20, bottom: 30, left: 45, right: 20 },
            tooltip: { trigger: 'axis', valueFormatter: (v: any) => (v == null ? '—' : `${Number(v).toFixed(1)}%`) },
            xAxis: { type: 'category', data: labels },
            yAxis: { type: 'value', max: 100, min: 0, axisLabel: { formatter: '{value}%' } },
            series: [
              { name: t('chart.historical'), type: 'line', data: hist, symbolSize: 7, lineStyle: { width: 2, color: '#3b82f6' }, itemStyle: { color: '#3b82f6' }, connectNulls: false },
              { name: t('chart.forecast'), type: 'line', data: proj, symbolSize: 7, symbol: 'diamond', lineStyle: { width: 2, color: '#3b82f6', type: 'dashed' }, itemStyle: { color: '#3b82f6' } },
              { name: t('chart.target'), type: 'line', data: labels.map(() => target), symbol: 'none', lineStyle: { width: 1, color: '#94a3b8', type: 'dotted' } },
            ],
          }}
        />
      </Panel>
      <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span><span className="font-semibold">{t('forecast.methodologyBold')}</span>{t('forecast.methodology')}</span>
      </p>
    </div>
  )
}

/** , verbatim thresholds. */
function useAnomalies(data: UtilizationData, t: ReturnType<typeof useTranslations>) {
  return useMemo(() => {
    const { employees } = intelligenceScope(data)
    const target = data.config.target
    const minHours = data.config.minHours

    const suddenDrops = employees
      .filter((e) => e.range.hours >= minHours && e.deltas.pctDelta < -15)
      .map((e) => ({ name: e.name, drop: e.deltas.pctDelta }))
      .sort((a, b) => a.drop - b.drop)
      .slice(0, 10)

    const avgHours = employees.length ? employees.reduce((s, e) => s + e.range.hours, 0) / employees.length : 0
    const overtimeNoValue = employees
      .filter((e) => e.range.hours >= avgHours * 1.2 && e.range.percentBilled < target - 20)
      .map((e) => ({ name: e.name, hours: e.range.hours, pct: e.range.percentBilled }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 10)

    const titleGroups = new Map<string, number[]>()
    for (const e of employees) {
      if (e.range.hours < minHours) continue
      const title = e.title || t('noTitle')
      if (!titleGroups.has(title)) titleGroups.set(title, [])
      titleGroups.get(title)!.push(e.deltas.pctDelta)
    }
    const titleDrift = [...titleGroups.entries()]
      .map(([title, deltas]) => {
        if (deltas.length < 2) return null
        const avgDrop = deltas.reduce((a, b) => a + b, 0) / deltas.length
        return { title, avgDrop, count: deltas.length, allNegative: deltas.every((d) => d < 0) }
      })
      .filter((t): t is NonNullable<typeof t> => !!t && t.avgDrop < -5 && t.allNegative)
      .sort((a, b) => a.avgDrop - b.avgDrop)
      .slice(0, 5)

    return { suddenDrops, overtimeNoValue, titleDrift, total: suddenDrops.length + overtimeNoValue.length + titleDrift.length }
  }, [data])
}

function AnomalyList({ items, empty }: { items: React.ReactNode[]; empty: string }) {
  return items.length ? (
    <ul className="max-h-64 divide-y divide-slate-50 overflow-y-auto dark:divide-slate-800/60">{items}</ul>
  ) : (
    <div className="py-8 text-center text-sm text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 size={22} className="mx-auto mb-1.5" />{empty}
    </div>
  )
}

function AnomaliesSub({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const a = useAnomalies(data, t)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={AlertTriangle} accent={a.total > 0 ? 'red' : 'emerald'} label={t('kpi.totalIssues')} value={String(a.total)} sub={t('sub.detectedAnomalies')} tone={a.total > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={ArrowDown} accent="red" label={t('kpi.suddenDrops')} value={String(a.suddenDrops.length)} sub={t('sub.drop15pp')} />
        <KpiCard icon={Clock} accent="amber" label={t('kpi.overtimeNoValue')} value={String(a.overtimeNoValue.length)} sub={t('sub.highHoursLowBillable')} />
        <KpiCard icon={UserRound} accent="violet" label={t('kpi.titleDrift')} value={String(a.titleDrift.length)} sub={t('sub.rolesTrendingDown')} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title={t('panels.suddenDrop')} hint={t('panels.suddenDropHint')} bodyClassName="p-0">
          <AnomalyList
            empty={t('empty.noSuddenDrops')}
            items={a.suddenDrops.map((x, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate text-slate-700 dark:text-slate-300" title={x.name}>{x.name}</span>
                <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-950/50 dark:text-rose-400">{x.drop.toFixed(0)}pp</span>
              </li>
            ))}
          />
        </Panel>
        <Panel title={t('kpi.overtimeNoValue')} hint={t('panels.overtimeHint')} bodyClassName="p-0">
          <AnomalyList
            empty={t('empty.noIssues')}
            items={a.overtimeNoValue.map((x, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate text-slate-700 dark:text-slate-300" title={x.name}>{x.name}</span>
                <span className="shrink-0 text-xs"><span className="text-slate-400">{hrs0(x.hours)}h</span> <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">{pct1(x.pct, 0)}</span></span>
              </li>
            ))}
          />
        </Panel>
        <Panel title={t('kpi.titleDrift')} hint={t('panels.titleDriftHint')} bodyClassName="p-0">
          <AnomalyList
            empty={t('empty.noDriftingTitles')}
            items={a.titleDrift.map((x, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate text-slate-700 dark:text-slate-300" title={x.title}>{x.title}</span>
                <span className="shrink-0 text-xs"><span className="text-slate-400">{t('empCount', { count: x.count })}</span> <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t('ppAvg', { avg: x.avgDrop.toFixed(0) })}</span></span>
              </li>
            ))}
          />
        </Panel>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500">{t('anomalyNote')}</p>
    </div>
  )
}

/** . */
function usePeers(data: UtilizationData, t: ReturnType<typeof useTranslations>) {
  return useMemo(() => {
    const { employees } = intelligenceScope(data)
    const minHours = data.config.minHours
    const groups = new Map<string, number[]>()
    for (const e of employees) {
      if (e.range.hours < minHours) continue
      const title = e.title || t('noTitle')
      if (!groups.has(title)) groups.set(title, [])
      groups.get(title)!.push(e.range.percentBilled)
    }
    return [...groups.entries()]
      .filter(([, pcts]) => pcts.length >= 2)
      .map(([title, pcts]) => {
        const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length
        const min = Math.min(...pcts), max = Math.max(...pcts)
        const stdDev = Math.sqrt(pcts.reduce((s, p) => s + (p - avg) ** 2, 0) / pcts.length)
        const outliers = pcts.filter((p) => Math.abs(p - avg) > stdDev * 1.5).length
        return { title, count: pcts.length, avg, min, max, spread: max - min, outliers }
      })
      .sort((a, b) => b.count - a.count)
  }, [data])
}

function PeersSub({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const target = data.config.target
  const peers = usePeers(data, t)
  const withOutliers = peers.filter((p) => p.outliers > 0).length
  const avgSpread = peers.length ? peers.reduce((s, p) => s + p.spread, 0) / peers.length : 0
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={UserRound} accent="sky" label={t('kpi.jobTitlesAnalyzed')} value={String(peers.length)} sub={t('sub.with2Plus')} />
        <KpiCard icon={AlertTriangle} accent={withOutliers > 0 ? 'amber' : 'emerald'} label={t('kpi.titlesWithOutliers')} value={String(withOutliers)} sub={t('sub.performanceVariance')} />
        <KpiCard icon={ArrowRightLeft} accent="violet" label={t('kpi.avgSpread')} value={pct1(avgSpread, 0)} sub={t('sub.maxMinusMin')} />
        <KpiCard icon={Target} accent="emerald" label={t('kpi.target')} value={`${target}%`} sub={t('sub.billableThreshold')} />
      </div>
      <Panel title={t('panels.peerComparison')} hint={t('panels.peerHint')} bodyClassName="p-0">
        <div className="max-h-104 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.jobTitle')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.employees')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.avgPct')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.min')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.max')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.spread')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.outliers')}</th>
              </tr>
            </thead>
            <tbody>
              {peers.length ? peers.map((p) => (
                <tr key={p.title} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="max-w-52 truncate px-4 py-2 font-medium text-slate-700 dark:text-slate-300" title={p.title}>{p.title}</td>
                  <td className="px-4 py-2 text-center tabular-nums text-slate-500 dark:text-slate-400">{p.count}</td>
                  <td className={cn('px-4 py-2 text-right font-bold tabular-nums', statusTone(p.avg, target).text)}>{pct1(p.avg, 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400">{pct1(p.min, 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400">{pct1(p.max, 0)}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', p.spread > 30 ? 'text-rose-600 dark:text-rose-400' : p.spread > 20 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400')}>{pct1(p.spread, 0)}</td>
                  <td className="px-4 py-2 text-center">{p.outliers > 0 ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">{p.outliers}</span> : <span className="text-emerald-500">—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">{t('empty.noPeerTitles')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span><span className="font-semibold">{t('peers.outliersBold')}</span>{t('peers.outliersNote')}</span>
      </p>
    </div>
  )
}

/** , verbatim formulas. */
function useWhatIf(data: UtilizationData, t: ReturnType<typeof useTranslations>) {
  return useMemo(() => {
    const { employees, depts } = intelligenceScope(data)
    const target = data.config.target
    const minHours = data.config.minHours

    const titleGroups = new Map<string, { employees: UGroupRow[]; totalCost: number; avgPct: number }>()
    for (const e of employees) {
      const t2 = e.title || t('noTitle')
      let g = titleGroups.get(t2)
      if (!g) { g = { employees: [], totalCost: 0, avgPct: 0 }; titleGroups.set(t2, g) }
      g.employees.push(e)
      g.totalCost += e.range.nonBillableCost
    }
    for (const g of titleGroups.values()) {
      const q = g.employees.filter((e) => e.range.hours >= minHours)
      const h = q.reduce((s, e) => s + e.range.hours, 0)
      const b = q.reduce((s, e) => s + e.range.billableHours, 0)
      g.avgPct = h > 0 ? (b / h) * 100 : 0
    }

    const improvements = [...titleGroups.entries()]
      .filter(([, g]) => g.avgPct < target && g.totalCost > 0)
      .map(([title, g]) => ({
        description: t('whatif.improve', { title }),
        detail: t('whatif.improveDetail', { count: g.employees.length, pct: g.avgPct.toFixed(0) }),
        savings: g.totalCost * 0.05,
      }))
      .sort((a, b) => b.savings - a.savings)

    const highDepts = depts.filter((d) => d.range.percentBilled >= target)
    const lowDepts = depts.filter((d) => d.range.percentBilled < target - 15)
    const reallocations: { from: string; to: string; employees: number }[] = []
    for (const from of lowDepts) {
      for (const to of highDepts) {
        if (from.id === to.id) continue
        const movable = employees.filter((e) => e.departmentId === from.id && e.range.percentBilled < target - 20)
        if (movable.length) reallocations.push({ from: from.name, to: to.name, employees: Math.min(2, movable.length) })
      }
    }

    const totalEmployees = employees.length || 1
    const totalCost = employees.reduce((s, e) => s + e.range.nonBillableCost, 0)
    const totalHours = employees.reduce((s, e) => s + e.range.hours, 0)
    const totalBillable = employees.reduce((s, e) => s + e.range.billableHours, 0)
    const costPerEmployee = totalCost / totalEmployees
    const avgBillable = totalHours > 0 ? (totalBillable / totalHours) * 100 : 0
    const avgHoursPerEmployee = totalHours / totalEmployees
    const nonBillHours = totalHours - totalBillable
    const costPerNonBillableHour = nonBillHours > 0 ? totalCost / nonBillHours : 0

    const titlePerf = [...titleGroups.entries()]
      .filter(([, g]) => g.employees.length >= 2)
      .map(([title, g]) => ({ title, avgPct: g.avgPct, count: g.employees.length }))
      .sort((a, b) => b.avgPct - a.avgPct)
    const bestTitle = titlePerf[0]
    const worstTitle = titlePerf[titlePerf.length - 1]

    const requiredBillable = Math.max(target, avgBillable + 5)
    const capacityHeadroom = avgBillable >= target ? Math.floor((avgBillable - target) / 5) : 0
    const efficiencyScore = Math.min(100, Math.round(
      (avgBillable / target) * 50 +
      Math.min(50, costPerEmployee < 5000 ? 50 : 50 - (costPerEmployee - 5000) / 200),
    ))
    const recommendation = requiredBillable > 85
      ? t('whatif.recExceptional')
      : requiredBillable > target
        ? t('whatif.recFocus', { title: bestTitle ? bestTitle.title : t('whatif.highBillableRoles'), avgPct: bestTitle ? bestTitle.avgPct.toFixed(0) : t('whatif.na') })
        : t('whatif.recSupports')
    const hiringOutlook = avgBillable >= target + 5 ? 'favorable' : avgBillable >= target - 5 ? 'neutral' : 'challenging'

    return {
      improvements,
      reallocations: reallocations.slice(0, 4),
      be: { costPerEmployee, requiredBillable, recommendation, avgBillable, avgHoursPerEmployee, costPerNonBillableHour, bestTitle, worstTitle, capacityHeadroom, efficiencyScore, hiringOutlook, totalEmployees },
    }
  }, [data])
}

function WhatIfSub({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const target = data.config.target
  const w = useWhatIf(data, t)
  const be = w.be
  const outlook = be.hiringOutlook === 'favorable'
    ? <Badge variant="success">{t('outlook.favorable')}</Badge>
    : be.hiringOutlook === 'neutral'
      ? <Badge variant="warning">{t('outlook.neutral')}</Badge>
      : <Badge variant="destructive">{t('outlook.challenging')}</Badge>

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Lightbulb} accent="emerald" label={t('kpi.opportunities')} value={String(w.improvements.length)} sub={t('sub.improvementScenarios')} />
        <KpiCard icon={DollarSign} accent="sky" label={t('kpi.potentialSavings')} value={money(w.improvements.reduce((s, i) => s + i.savings, 0))} sub={t('sub.ifAllImplemented')} tone="positive" />
        <KpiCard icon={Target} accent="violet" label={t('kpi.efficiencyScore')} value={String(be.efficiencyScore)} sub={t('sub.outOf100')} tone={be.efficiencyScore >= 70 ? 'positive' : be.efficiencyScore >= 50 ? 'neutral' : 'negative'} />
        <KpiCard icon={UserPlus} accent="slate" label={t('kpi.capacityHeadroom')} value={String(be.capacityHeadroom)} sub={t('sub.hiresAtEfficiency')} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Panel title={t('panels.improvementOpportunities')} hint={t('panels.improvementHint')} bodyClassName="p-0">
            {w.improvements.length ? (
              <ul className="max-h-80 divide-y divide-slate-50 overflow-y-auto dark:divide-slate-800/60">
                {w.improvements.slice(0, 8).map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{s.description}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500">{s.detail}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">{t('whatif.save', { amount: money(s.savings) })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-400">{t('empty.noImprovements')}</p>
            )}
          </Panel>
          {w.reallocations.length ? (
            <div className="mt-5">
              <Panel title={t('panels.reallocationIdeas')} bodyClassName="p-0">
                <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
                  {w.reallocations.slice(0, 3).map((r, i) => (
                    <li key={i} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                      <span className="max-w-32 truncate text-slate-700 dark:text-slate-300">{r.from}</span>
                      <ArrowRightLeft size={13} className="shrink-0 text-slate-400" />
                      <span className="max-w-32 truncate text-slate-700 dark:text-slate-300">{r.to}</span>
                      <span className="ml-auto rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-400">{t('empCount', { count: r.employees })}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          ) : null}
        </div>

        <div className="lg:col-span-5">
          <Panel title={t('panels.hiringIntelligence')} actions={outlook}>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                <p className="text-xs text-slate-400 dark:text-slate-500">{t('whatif.breakEvenRate')}</p>
                <p className="text-2xl font-bold text-sky-600 tabular-nums dark:text-sky-400">{pct1(be.requiredBillable, 0)}</p>
                <p className="text-[10px] text-slate-400">{t('whatif.billablePctLabel')}</p>
              </div>
              <div className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                <p className="text-xs text-slate-400 dark:text-slate-500">{t('whatif.avgCostEmployee')}</p>
                <p className="text-2xl font-bold text-slate-800 tabular-nums dark:text-slate-200">{money(be.costPerEmployee)}</p>
                <p className="text-[10px] text-slate-400">{t('whatif.nonBillableLabel')}</p>
              </div>
            </div>
            <ul className="mt-3 divide-y divide-slate-50 rounded-lg border border-slate-100 text-sm dark:divide-slate-800/60 dark:border-slate-800">
              {[
                [t('whatif.teamAvgBillable'), pct1(be.avgBillable), be.avgBillable >= target ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'],
                [t('whatif.avgHoursEmployee'), hrs0(be.avgHoursPerEmployee), ''],
                [t('whatif.costPerNonBillHour'), money0(be.costPerNonBillableHour), ''],
                [t('whatif.totalEmployees'), String(be.totalEmployees), ''],
              ].map(([label, value, tone]) => (
                <li key={label as string} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
                  <span className={cn('font-semibold tabular-nums', tone || 'text-slate-800 dark:text-slate-200')}>{value}</span>
                </li>
              ))}
            </ul>
            {be.bestTitle ? (
              <div className="mt-3 flex gap-2">
                <div className="flex-1 rounded-lg bg-emerald-50 p-2.5 text-xs dark:bg-emerald-950/30">
                  <p className="text-slate-500 dark:text-slate-400">{t('whatif.bestTitle')}</p>
                  <p className="truncate font-semibold text-slate-800 dark:text-slate-200" title={be.bestTitle.title}>{be.bestTitle.title}</p>
                  <p className="text-emerald-600 dark:text-emerald-400">{t('ppAvg', { avg: pct1(be.bestTitle.avgPct, 0) })}</p>
                </div>
                {be.worstTitle && be.worstTitle.title !== be.bestTitle.title ? (
                  <div className="flex-1 rounded-lg bg-rose-50 p-2.5 text-xs dark:bg-rose-950/30">
                    <p className="text-slate-500 dark:text-slate-400">{t('whatif.needsFocus')}</p>
                    <p className="truncate font-semibold text-slate-800 dark:text-slate-200" title={be.worstTitle.title}>{be.worstTitle.title}</p>
                    <p className="text-rose-600 dark:text-rose-400">{t('ppAvg', { avg: pct1(be.worstTitle.avgPct, 0) })}</p>
                  </div>
                ) : null}
              </div>
            ) : null}
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600 dark:bg-slate-800/40 dark:text-slate-300">
              <Lightbulb size={13} className="mt-0.5 shrink-0 text-amber-500" />
              {be.recommendation}
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}

/**  → ECharts treemap (size = hours, colour = billable %). */
function TreemapSub({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const { depts, employees } = intelligenceScope(data)

  const treeData = useMemo(() => {
    return depts
      .filter((d) => d.range.hours > 0)
      .map((d) => {
        const deptEmps = employees.filter((e) => e.departmentId === d.id)
        const titles = new Map<string, UGroupRow[]>()
        for (const e of deptEmps) {
          const title = e.title || t('noTitle')
          if (!titles.has(title)) titles.set(title, [])
          titles.get(title)!.push(e)
        }
        return {
          name: d.name,
          value: d.range.hours,
          pct: d.range.percentBilled,
          itemStyle: { color: treemapColor(d.range.percentBilled) },
          children: [...titles.entries()].map(([title, emps]) => {
            const h = emps.reduce((s, e) => s + e.range.hours, 0)
            const b = emps.reduce((s, e) => s + e.range.billableHours, 0)
            const pct = h > 0 ? (b / h) * 100 : 0
            return {
              name: title,
              value: h,
              pct,
              itemStyle: { color: treemapColor(pct) },
              children: emps
                .filter((e) => e.range.hours > 0)
                .map((e) => ({ name: e.name, value: e.range.hours, pct: e.range.percentBilled, itemStyle: { color: treemapColor(e.range.percentBilled) } })),
            }
          }),
        }
      })
  }, [depts, employees])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-center gap-2 text-xs text-slate-400 dark:text-slate-500">
        <span>{t('chart.nonBillable')}</span>
        <div className="h-2 w-40 rounded-full" style={{ background: 'linear-gradient(to right, #fecaca, #fed7aa, #fef08a, #bbf7d0, #86efac)' }} />
        <span>{t('chart.billable')}</span>
      </div>
      <Panel title={t('panels.treemap')} hint={t('panels.treemapHint')}>
        <Chart
          height={460}
          option={{
            tooltip: {
              formatter: (p: any) => `<b>${p.name}</b><br/>${t('table.hours')}: <b>${Math.round(p.value).toLocaleString('en-US')}</b><br/>${t('chart.billable')}: <b>${(p.data?.pct ?? 0).toFixed(1)}%</b>`,
            },
            series: [{
              type: 'treemap',
              data: treeData,
              roam: false,
              nodeClick: 'zoomToNode',
              breadcrumb: { show: true, top: 4, itemStyle: { color: '#475569', textStyle: { color: '#f1f5f9' } } },
              label: { show: true, formatter: (p: any) => `${p.name}\n${Math.round(p.value).toLocaleString('en-US')}h`, fontSize: 12, color: '#334155' },
              upperLabel: { show: true, height: 24, color: '#334155', fontWeight: 'bold' },
              itemStyle: { borderColor: 'rgba(255,255,255,0.9)', borderWidth: 3, gapWidth: 3 },
              levels: [
                { itemStyle: { borderWidth: 0, gapWidth: 4 } },
                { itemStyle: { gapWidth: 3 }, upperLabel: { show: true } },
                { itemStyle: { gapWidth: 2 } },
              ],
            }],
          }}
        />
      </Panel>
      <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
        <span>{t('treemap.clickDrill')}</span><span>{t('treemap.sizeHours')}</span><span>{t('treemap.colourBillable')}</span><span>{t('treemap.breadcrumb')}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- Departments */

function DepartmentsTab({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const target = data.config.target
  const [view, setView] = useState<'cards' | 'table'>('cards')
  // Sparkline: history % billed per dept, oldest → newest, then current.
  const sparkValues = (id: string, current: number) => [
    ...data.history.periods.map((p) => p.deptPct[id] ?? 0).reverse(),
    current,
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">≥{target}%</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">{target - 10}–{target}%</span>
          <span className="rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-950/50 dark:text-rose-400">&lt;{target - 10}%</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t('noBillExpectation')}</span>
        </div>
        <div className="flex gap-1">
          <button type="button" aria-label={`${t('show')} ${t('tabs.departments')}`} aria-pressed={view === 'cards'} onClick={() => setView('cards')} className={cn('rounded-md border p-1.5', view === 'cards' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-slate-200 text-slate-400 dark:border-slate-700')}><Grid3X3 size={15} /></button>
          <button type="button" aria-label={`${t('show')} ${t('table')}`} aria-pressed={view === 'table'} onClick={() => setView('table')} className={cn('rounded-md border p-1.5', view === 'table' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-slate-200 text-slate-400 dark:border-slate-700')}><Table2 size={15} /></button>
        </div>
      </div>

      {view === 'cards' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data.departments.map((d) => {
            const pct = d.range.percentBilled
            const tone = d.noBillable ? { text: 'text-slate-400 dark:text-slate-500', bar: 'bg-slate-400' } : statusTone(pct, target)
            return (
              <div key={d.id} className={cn('rounded-xl border bg-white p-4 shadow-sm dark:bg-slate-900', d.noBillable ? 'border-slate-200 opacity-80 dark:border-slate-800' : 'border-slate-200/80 dark:border-slate-800')}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-bold text-slate-800 dark:text-slate-200" title={d.name}>{d.name}</h3>
                  {d.noBillable
                    ? <span className="shrink-0 text-[10px] font-medium text-slate-400">{t('noBillExpShort')}</span>
                    : pct >= target ? <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
                      : pct >= target - 10 ? <AlertTriangle size={16} className="shrink-0 text-amber-500" />
                        : <AlertTriangle size={16} className="shrink-0 text-rose-500" />}
                </div>
                <div className="my-3 text-center">
                  <p className={cn('text-3xl font-bold tabular-nums', tone.text)}>{pct1(pct)}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">{t('chart.billable')}</p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-slate-400 dark:text-slate-500">{t('prior', { pct: pct1(d.prior.percentBilled) })}</span>
                  <TrendDelta delta={d.deltas.pctDelta} goodIfUp />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
                  <div>
                    <p className="text-slate-400 dark:text-slate-500">{t('table.hours')}</p>
                    <p className="font-bold tabular-nums text-slate-800 dark:text-slate-200">{hrs0(d.range.hours)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-slate-400 dark:text-slate-500">{t('table.nonBillCost')}</p>
                    <p className="font-bold tabular-nums text-rose-600 dark:text-rose-400">{money(d.range.nonBillableCost)}</p>
                  </div>
                </div>
                <Sparkline values={sparkValues(d.id, pct)} />
              </div>
            )
          })}
        </div>
      ) : (
        <GroupTable rows={data.departments} target={target} kind="department" />
      )}
    </div>
  )
}

/* --------------------------------------------------- shared sortable table */

type SortKey = 'name' | 'percentBilled' | 'delta' | 'nonBillableCost' | 'hours'

function GroupTable({ rows, target, kind, onDrill }: { rows: UGroupRow[]; target: number; kind: 'department' | 'item' | 'employee'; onDrill?: (r: UGroupRow) => void }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const [sortKey, setSortKey] = useState<SortKey>(kind === 'employee' ? 'percentBilled' : 'nonBillableCost')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(kind === 'employee' ? 'asc' : 'desc')

  const val = (r: UGroupRow, k: SortKey): number | string =>
    k === 'name' ? r.name : k === 'percentBilled' ? r.range.percentBilled : k === 'delta' ? r.deltas.pctDelta : k === 'nonBillableCost' ? r.range.nonBillableCost : r.range.hours
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = val(a, sortKey), bv = val(b, sortKey)
    const c = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return sortDir === 'asc' ? c : -c
  }), [rows, sortKey, sortDir])

  const header = (label: string, k: SortKey, align = 'text-right') => (
    <th
      className={cn('cursor-pointer select-none px-4 py-2 font-medium hover:text-slate-700 dark:hover:text-slate-200', align)}
      onClick={() => { if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc') } }}
    >
      {label}{sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="max-h-128 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              {header(kind === 'department' ? t('table.department') : kind === 'item' ? t('entries.item') : t('entries.employee'), 'name', 'text-left')}
              {header(t('table.pctBilled'), 'percentBilled')}
              <th className="px-4 py-2 text-right font-medium">{t('table.pctPrior')}</th>
              {header(t('table.change'), 'delta')}
              {header(t('table.nonBillCost'), 'nonBillableCost')}
              {header(t('table.totalHrs'), 'hours')}
              <th className="px-4 py-2 text-right font-medium text-emerald-600/70 dark:text-emerald-500/70">{t('chart.billable')}</th>
              <th className="px-4 py-2 text-right font-medium text-rose-500/70">{t('table.nonBill')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                onClick={onDrill ? () => onDrill(r) : undefined}
                className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', onDrill && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40', r.noBillable && 'opacity-60')}
              >
                <td className="px-4 py-2">
                  <span className="font-medium text-slate-800 dark:text-slate-200">{r.name}</span>
                  {r.noBillable ? <span className="ml-2 text-[10px] text-slate-400">{t('noBillExpShort')}</span> : null}
                  {kind === 'employee' && r.title ? <span className="block text-xs text-slate-400 dark:text-slate-500">{r.title}</span> : null}
                </td>
                <td className={cn('px-4 py-2 text-right font-bold tabular-nums', r.noBillable ? 'text-slate-400' : statusTone(r.range.percentBilled, target).text)}>{pct1(r.range.percentBilled)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">{pct1(r.prior.percentBilled)}</td>
                <td className="px-4 py-2 text-right"><TrendDelta delta={r.deltas.pctDelta} goodIfUp /></td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(r.range.nonBillableCost)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{hrs0(r.range.hours)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{hrs0(r.range.billableHours)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-rose-500">{hrs0(r.range.nonBillableHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- Items */

function ItemsTab({ data, onDrill }: { data: UtilizationData; onDrill: (f: Flyout) => void }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const target = data.config.target
  const [search, setSearch] = useState('')
  const items = useMemo(
    () => data.items.filter((i) => (i.range.hours > 0 || i.range.nonBillableCost > 0) && i.name.toLowerCase().includes(search.toLowerCase())),
    [data.items, search],
  )
  const all = data.items.filter((i) => i.range.hours > 0 || i.range.nonBillableCost > 0)
  const totalHours = all.reduce((s, i) => s + i.range.hours, 0)
  const billableHours = all.reduce((s, i) => s + i.range.billableHours, 0)
  const avgBillable = totalHours > 0 ? (billableHours / totalHours) * 100 : 0
  const above = all.filter((i) => i.range.percentBilled >= target).length
  const below = all.filter((i) => i.range.percentBilled < target - 10).length
  const highest = all[0]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard icon={Box} accent="sky" label={t('kpi.serviceItems')} value={String(all.length)} sub={t('sub.withActivity')} />
        <KpiCard icon={PieIcon} accent="emerald" label={t('kpi.avgBillablePct')} value={pct1(avgBillable)} sub={t('sub.acrossItems')} tone={avgBillable >= target ? 'positive' : 'negative'} />
        <KpiCard icon={Clock} accent="violet" label={t('kpi.avgHoursItem')} value={hrs0(all.length ? totalHours / all.length : 0)} sub={t('sub.perServiceItem')} />
        <KpiCard icon={CheckCircle2} accent="emerald" label={t('kpi.aboveTarget')} value={String(above)} sub={t('sub.belowTargetCount', { count: below })} tone="positive" />
        <KpiCard icon={AlertTriangle} accent="amber" label={t('kpi.highestCost')} value={highest ? money(highest.range.nonBillableCost) : '—'} sub={highest?.name ?? '—'} tone="negative" />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchItems')} className="h-8 w-56 rounded-md border border-slate-200 bg-white pl-8 pr-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
        </div>
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">{t('itemsWithActivity', { count: items.length })}</span>
      </div>
      <GroupTable rows={items} target={target} kind="item" onDrill={(r) => onDrill({ kind: 'item', id: r.id, name: r.name, sub: `${hrs0(r.range.hours)} ${t('unit.hrs')} · ${pct1(r.range.percentBilled)} ${t('unit.billable')}` })} />
    </div>
  )
}

/* ------------------------------------------------------------------ Titles */

interface TitleGroup {
  title: string
  employees: UGroupRow[]
  hours: number
  billableHours: number
  nonBillableCost: number
  percentBilled: number
}

function TitlesTab({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const target = data.config.target
  const [open, setOpen] = useState<TitleGroup | null>(null)

  const titles = useMemo(() => {
    const groups = new Map<string, TitleGroup>()
    for (const e of data.employees) {
      const title = e.title || t('noTitle')
      let g = groups.get(title)
      if (!g) { g = { title, employees: [], hours: 0, billableHours: 0, nonBillableCost: 0, percentBilled: 0 }; groups.set(title, g) }
      g.employees.push(e)
      g.hours += e.range.hours
      g.billableHours += e.range.billableHours
      g.nonBillableCost += e.range.nonBillableCost
    }
    return [...groups.values()]
      .map((g) => ({ ...g, percentBilled: g.hours > 0 ? (g.billableHours / g.hours) * 100 : 0, employeeCount: g.employees.length }))
  }, [data.employees])
  const { sorted: sortedTitles, SortTh } = useSort(titles, { key: 'nonBillableCost', dir: 'desc' })

  const sortedByPct = [...titles].sort((a, b) => b.percentBilled - a.percentBilled)
  const best = sortedByPct[0]
  const worst = sortedByPct[sortedByPct.length - 1]
  const aboveT = titles.filter((t) => t.percentBilled >= target).length
  const belowT = titles.filter((t) => t.percentBilled < target - 10).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard icon={UserRound} accent="violet" label={t('kpi.jobTitles')} value={String(titles.length)} sub={t('sub.uniqueRoles')} />
        <KpiCard icon={Users} accent="sky" label={t('kpi.avgTeamSize')} value={(titles.length ? data.employees.length / titles.length : 0).toFixed(1)} sub={t('sub.employeesPerTitle')} />
        <KpiCard icon={Trophy} accent="emerald" label={t('kpi.bestTitle')} value={best ? pct1(best.percentBilled, 0) : '—'} sub={best?.title ?? '—'} tone="positive" />
        <KpiCard icon={CheckCircle2} accent="emerald" label={t('kpi.aboveTarget')} value={String(aboveT)} sub={t('sub.belowTargetCount', { count: belowT })} />
        <KpiCard icon={AlertTriangle} accent="amber" label={t('kpi.needsAttention')} value={worst ? pct1(worst.percentBilled, 0) : '—'} sub={worst?.title ?? '—'} tone="negative" />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SortTh label={t('table.jobTitle')} col="title" align="left" defaultDir="asc" />
              <SortTh label={t('table.employees')} col="employeeCount" />
              <SortTh label={t('table.pctBilled')} col="percentBilled" />
              <SortTh label={t('table.totalHrs')} col="hours" />
              <SortTh label={t('table.nonBillCost')} col="nonBillableCost" />
            </tr>
          </thead>
          <tbody>
            {sortedTitles.map((t) => (
              <tr key={t.title} onClick={() => setOpen(t)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">{t.title}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{t.employees.length}</td>
                <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', statusTone(t.percentBilled, target).text)}>{pct1(t.percentBilled)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{hrs0(t.hours)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-rose-600 dark:text-rose-400">{money0(t.nonBillableCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open ? (
        <Drawer open onClose={() => setOpen(null)} size="lg" title={open.title} description={t('titles.drawerDesc', { count: open.employees.length, billable: pct1(open.percentBilled), cost: money(open.nonBillableCost) })} bodyClassName="p-0 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('entries.employee')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.pctBilled')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.hours')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('chart.billable')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {[...open.employees].sort((a, b) => a.range.percentBilled - b.range.percentBilled).map((e) => (
                <tr key={e.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{e.name}</span>
                    <span className="block text-xs text-slate-400 dark:text-slate-500">{e.departmentName}</span>
                  </td>
                  <td className={cn('px-4 py-2 text-right font-bold tabular-nums', statusTone(e.range.percentBilled, target).text)}>{pct1(e.range.percentBilled)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{hrs0(e.range.hours)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{hrs0(e.range.billableHours)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-rose-500">{money0(e.range.nonBillableCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Drawer>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- Employees */

function EmployeesTab({ data, onDrill }: { data: UtilizationData; onDrill: (f: Flyout) => void }) {
  const t = useTranslations('analytics.utilization')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const target = data.config.target
  const minHours = data.config.minHours
  const [dept, setDept] = useState('__ALL__')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'heatmap' | 'table'>('heatmap')
  const [showLow, setShowLow] = useState(false)

  const filtered = useMemo(
    () => data.employees.filter((e) => (dept === '__ALL__' || e.departmentId === dept) && e.name.toLowerCase().includes(search.toLowerCase())),
    [data.employees, dept, search],
  )
  const qualified = filtered.filter((e) => e.range.hours >= minHours).sort((a, b) => a.range.percentBilled - b.range.percentBilled)
  const low = filtered.filter((e) => e.range.hours < minHours)

  // KPI stats (weighted, ).
  const qHours = qualified.reduce((s, e) => s + e.range.hours, 0)
  const qBillable = qualified.reduce((s, e) => s + e.range.billableHours, 0)
  const avgBillable = qHours > 0 ? (qBillable / qHours) * 100 : 0
  const above = qualified.filter((e) => e.range.percentBilled >= target).length
  const near = qualified.filter((e) => e.range.percentBilled >= target - 10 && e.range.percentBilled < target).length
  const belowN = qualified.filter((e) => e.range.percentBilled < target - 10).length
  const top = [...qualified].sort((a, b) => b.range.percentBilled - a.range.percentBilled)[0]
  const avgHours = filtered.length ? filtered.reduce((s, e) => s + e.range.hours, 0) / filtered.length : 0

  const drill = (e: UGroupRow) => {
    // Peer strip: this employee vs same-title peers' average billable %.
    const peers = e.title ? data.employees.filter((p) => p.title === e.title && p.range.hours >= minHours) : []
    const peer = e.title && peers.length >= 2
      ? { title: e.title, empPct: e.range.percentBilled, peerAvg: peers.reduce((a, p) => a + p.range.percentBilled, 0) / peers.length, peerCount: peers.length }
      : undefined
    onDrill({ kind: 'employee', id: e.id, name: e.name, sub: `${e.title ?? ''} · ${e.departmentName ?? ''} · ${pct1(e.range.percentBilled)} ${t('unit.billable')}`, peer })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard icon={Users} accent="sky" label={t('kpi.employees')} value={String(filtered.length)} sub={t('sub.qualified', { count: qualified.length, minHours })} />
        <KpiCard icon={PieIcon} accent="emerald" label={t('kpi.avgBillablePct')} value={pct1(avgBillable)} sub={t('sub.hoursWeighted')} tone={avgBillable >= target ? 'positive' : 'negative'} />
        <KpiCard icon={Clock} accent="violet" label={t('kpi.avgHours')} value={hrs0(avgHours)} sub={t('sub.perEmployee')} />
        <KpiCard icon={Trophy} accent="emerald" label={t('kpi.topPerformer')} value={top ? pct1(top.range.percentBilled, 0) : '—'} sub={top?.name ?? '—'} tone="positive" />
        <KpiCard icon={AlertTriangle} accent={belowN > 0 ? 'red' : 'emerald'} label={t('kpi.belowTarget')} value={String(belowN)} sub={t('sub.aboveNear', { above, near })} tone={belowN > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-48" triggerClassName="h-8 text-sm">
          <option value="__ALL__">{t('allDepartments')}</option>
          {data.departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </Select>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchEmployees')} className="h-8 w-52 rounded-md border border-slate-200 bg-white pl-8 pr-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
        </div>
        <div className="ml-auto flex gap-1">
          <button type="button" onClick={() => setView('heatmap')} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium', view === 'heatmap' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-slate-200 text-slate-400 dark:border-slate-700')}><Grid3X3 size={13} />{t('heatmap')}</button>
          <button type="button" onClick={() => setView('table')} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium', view === 'table' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-slate-200 text-slate-400 dark:border-slate-700')}><Table2 size={13} />{t('table')}</button>
        </div>
      </div>

      {view === 'heatmap' ? (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {qualified.map((e) => {
              const tone = statusTone(e.range.percentBilled, target)
              return (
                <button key={e.id} type="button" onClick={() => drill(e)} className="rounded-lg border-l-4 bg-white p-2.5 text-left shadow-sm ring-1 ring-slate-200/70 transition-shadow hover:shadow dark:bg-slate-900 dark:ring-slate-800" style={{ borderLeftColor: tone.hex }}>
                  <div className="flex items-start justify-between gap-1">
                    <p className="truncate text-xs font-bold text-slate-800 dark:text-slate-200" title={e.name}>{e.name}</p>
                    {Math.abs(e.deltas.pctDelta) >= 0.5 ? (e.deltas.pctDelta > 0 ? <TrendingUp size={11} className="shrink-0 text-emerald-500" /> : <TrendingDown size={11} className="shrink-0 text-rose-500" />) : null}
                  </div>
                  <p className="truncate text-[10px] text-slate-400 dark:text-slate-500" title={e.title}>{e.title}</p>
                  <div className="mt-1 flex items-end justify-between">
                    <span className={cn('text-lg font-bold tabular-nums', tone.text)}>{pct1(e.range.percentBilled, 0)}</span>
                    <span className="text-right text-[10px] leading-tight text-slate-400 dark:text-slate-500">
                      {hrs0(e.range.hours)}h
                      {e.range.nonBillableCost > 0 ? <span className="block text-rose-500">{money(e.range.nonBillableCost)}</span> : null}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
          {low.length ? (
            <div>
              <button type="button" onClick={() => setShowLow(!showLow)} className="text-xs text-slate-400 underline-offset-2 hover:underline dark:text-slate-500">
                {showLow ? t('hide') : t('show')} {t('lowHoursCount', { count: low.length, minHours })}
              </button>
              {showLow ? (
                <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {low.map((e) => (
                    <div key={e.id} className="rounded-lg bg-slate-50 p-2.5 opacity-70 dark:bg-slate-800/50">
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">{e.name}</p>
                      <div className="mt-1 flex items-end justify-between text-[11px] text-slate-400">
                        <span className="tabular-nums">{pct1(e.range.percentBilled, 0)}</span>
                        <span className="tabular-nums">{hrs0(e.range.hours)}h</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <GroupTable rows={filtered} target={target} kind="employee" onDrill={drill} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------ Configuration */

function ConfigTab({ data }: { data: UtilizationData }) {
  const t = useTranslations('analytics.utilization')
  const items = [
    { label: t('config.priorRange'), value: `${data.prior.from} → ${data.prior.to}`, note: t('config.priorRangeNote') },
    { label: t('config.historyPeriods'), value: String(data.history.periods.length), note: t('config.historyNote', { months: data.history.periodMonths }) },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="utilization"
          fields={[
            { key: 'targetBillablePct', label: t('config.fields.targetBillable.label'), help: t('config.fields.targetBillable.help'), min: 10, max: 100, step: 1 },
            { key: 'costSpikeThreshold', label: t('config.fields.costSpike.label'), help: t('config.fields.costSpike.help'), min: 0, max: 1_000_000, step: 100 },
            { key: 'minHours', label: t('config.fields.minHours.label'), help: t('config.fields.minHours.help'), min: 0, max: 500, step: 1 },
          ]}
          values={{ targetBillablePct: data.config.target, costSpikeThreshold: data.config.costSpike, minHours: data.config.minHours }}
          defaults={{ targetBillablePct: 70, costSpikeThreshold: 1000, minHours: 10 }}
        />
        <Panel title={t('panels.modelAssumptions')} bodyClassName="p-0">
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
      <Panel title={t('panels.dataSources')} icon={Info}>
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>{t('sources.intro')}<span className="font-semibold">{t('sources.timeEntries')}</span>{t('sources.introTail')}</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-500 dark:text-slate-400">
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('sources.billableBold')}</span>{t('sources.billableItem')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('sources.nonBillCostBold')}</span>{t('sources.nonBillCostItem')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('sources.jobTitleBold')}</span>{t('sources.jobTitleMid')}<em>{t('sources.dominantClass')}</em>{t('sources.jobTitleItem')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('noBillExpectation')}</span>{t('sources.noBillItem')}</li>
          </ul>
        </div>
      </Panel>
    </div>
  )
}
