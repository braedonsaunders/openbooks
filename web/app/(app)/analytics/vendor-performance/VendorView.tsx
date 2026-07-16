'use client'

import { useMemo, useState } from 'react'
import { Truck, DollarSign, Trophy, Layers, PieChart as PieIcon, BarChart3, Table2, Clock, TimerReset, HandCoins, ClipboardList, Grid2x2, Star } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { VendorData, VendorRow, SpendTier, Grade, Quadrant } from '../../../../lib/analytics/vendor-data'
import { Gauge } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { DivergingBar, Donut, TrendChart, Chart } from '../_ui/charts'
import { fmtMoney, fmtPct } from '../_ui/format'

const TABS = ['overview', 'payment', 'scorecard', 'matrix', 'vendors'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', payment: 'Payment Behavior', scorecard: 'Scorecard', matrix: 'Leverage Matrix', vendors: 'Vendors' }

const money = (n: number) => fmtMoney(n, { compact: true })

const TIER_LABEL: Record<SpendTier, string> = { strategic: 'Strategic', core: 'Core', tactical: 'Tactical', tail: 'Tail' }
const TIER_STYLE: Record<SpendTier, string> = {
  strategic: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  core: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  tactical: 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  tail: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
}
const GRADE_STYLE: Record<Grade, string> = {
  A: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  B: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  C: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  F: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
const QUADRANT: Record<Quadrant, { label: string; color: string; desc: string }> = {
  strategic: { label: 'Strategic', color: '#8b5cf6', desc: 'High spend, reliable — partner & protect' },
  commodity: { label: 'Commodity', color: '#ef4444', desc: 'High spend, strained — renegotiate or dual-source' },
  niche: { label: 'Niche', color: '#0d9488', desc: 'Low spend, reliable — nurture' },
  transactional: { label: 'Transactional', color: '#94a3b8', desc: 'Low spend, low engagement — automate / consolidate' },
}

export function VendorView({ data }: { data: VendorData }) {
  const [tab, setTab] = useState<Tab>('overview')
  const t = data.totals
  const diversification = Math.max(0, Math.min(100, (1 - t.hhi) * 100))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={diversification} label={diversification >= 85 ? 'Diversified' : diversification >= 70 ? 'Balanced' : 'Concentrated'} size={132} thickness={12} showTicks={false} />
        </div>
        <KpiCard icon={Truck} accent="sky" label="Active Vendors" value={String(t.vendors)} sub="in period" />
        <KpiCard icon={DollarSign} accent="violet" label="Total Spend" value={money(t.spend)} sub={t.yoyPct === null ? 'in period' : `YoY ${fmtPct(t.yoyPct)}`} tone={(t.yoyPct ?? 0) <= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Clock} accent={(t.onTimePct ?? 0) >= 0.6 ? 'emerald' : 'amber'} label="On-Time Rate" value={t.onTimePct === null ? '—' : fmtPct(t.onTimePct)} sub="bills paid by due date" />
        <KpiCard icon={PieIcon} accent="emerald" label="Top 5 Share" value={fmtPct(t.top5SharePct)} sub="spend concentration" />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'payment' ? <PaymentTab data={data} /> : null}
        {tab === 'scorecard' ? <ScorecardTab data={data} /> : null}
        {tab === 'matrix' ? <MatrixTab data={data} /> : null}
        {tab === 'vendors' ? <VendorsTab data={data} /> : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */
function OverviewTab({ data }: { data: VendorData }) {
  const t = data.totals
  const top = data.rows.slice(0, 10)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={DollarSign} accent="violet" label="Total Spend" value={money(t.spend)} sub={`${t.bills} bills`} />
        <KpiCard icon={Trophy} accent="teal" label="Top Vendor" value={top[0] ? money(top[0].spend) : '—'} sub={top[0]?.name ?? '—'} />
        <KpiCard icon={BarChart3} accent="sky" label="Avg Bill" value={money(t.avgBill)} sub="per bill" />
        <KpiCard icon={Layers} accent="amber" label="Concentration (HHI)" value={t.hhiScaled.toString()} sub={t.hhiScaled > 2500 ? 'highly concentrated' : t.hhiScaled > 1500 ? 'moderate' : 'diversified'} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Top Vendors by Spend" icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => r.spend)} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title="Spend by Tier" icon={PieIcon}>
          <Donut data={data.tierBreakdown.filter((x) => x.spend > 0).map((x) => ({ name: TIER_LABEL[x.tier], value: x.spend }))} height={220} />
        </Panel>
      </div>
      <Panel title="Spend Trend (12mo)" icon={BarChart3}>
        <TrendChart labels={data.monthly.map((m) => m.label)} area height={200} series={[{ name: 'Spend', data: data.monthly.map((m) => m.spend), color: '#8b5cf6' }]} />
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------- Payment Behavior */
function PaymentTab({ data }: { data: VendorData }) {
  const [sort, setSort] = useState<'spend' | 'avgDaysToPay' | 'onTimePct' | 'lateSpend'>('lateSpend')
  const t = data.totals
  const paid = data.rows.filter((r) => r.paidBills > 0)
  const rows = [...paid].sort((a, b) => {
    if (sort === 'onTimePct') return (b.onTimePct ?? -1) - (a.onTimePct ?? -1)
    return (b[sort] as number) - (a[sort] as number)
  })
  const worst = [...paid].filter((r) => r.lateSpend > 0).sort((a, b) => b.lateSpend - a.lateSpend).slice(0, 10)

  const Th = ({ label, k }: { label: string; k?: typeof sort }) => (
    <th className="px-4 py-2 text-right font-medium">
      {k ? <button type="button" onClick={() => setSort(k)} className={cn('hover:text-slate-700 dark:hover:text-slate-300', sort === k && 'text-teal-600 dark:text-teal-400')}>{label}</button> : label}
    </th>
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Clock} accent={(t.onTimePct ?? 0) >= 0.6 ? 'emerald' : 'red'} label="On-Time Rate" value={t.onTimePct === null ? '—' : fmtPct(t.onTimePct)} sub="bills paid by due date" tone={(t.onTimePct ?? 0) >= 0.6 ? 'positive' : 'negative'} />
        <KpiCard icon={TimerReset} accent="sky" label="Avg Days to Pay" value={t.avgDaysToPay === null ? '—' : `${Math.round(t.avgDaysToPay)}d`} sub="from bill to payment" />
        <KpiCard icon={HandCoins} accent="amber" label="Late-Paid Spend" value={money(t.lateSpend)} sub="paid after due date" tone="negative" />
        <KpiCard icon={ClipboardList} accent="violet" label="Vendors Paid" value={String(paid.length)} sub="with payment history" />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Payment Behaviour by Vendor" icon={ClipboardList} bodyClassName="p-0">
            <div className="max-h-[30rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Vendor</th>
                    <Th label="Spend" k="spend" />
                    <Th label="Paid" />
                    <Th label="Avg Days" k="avgDaysToPay" />
                    <Th label="On-Time" k="onTimePct" />
                    <Th label="Late Spend" k="lateSpend" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.spend)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.paidBills}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', (r.avgDaysToPay ?? 0) > 45 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300')}>{r.avgDaysToPay === null ? '—' : `${Math.round(r.avgDaysToPay)}d`}</td>
                      <td className={cn('px-4 py-2 text-right font-medium tabular-nums', (r.onTimePct ?? 0) >= 0.6 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{r.onTimePct === null ? '—' : fmtPct(r.onTimePct)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.lateSpend > 0 ? money(r.lateSpend) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        <Panel title="Most Late-Paid Vendors" icon={HandCoins}>
          {worst.length ? <DivergingBar labels={worst.map((r) => r.name)} values={worst.map((r) => r.lateSpend)} height={Math.max(200, worst.length * 26)} /> : <p className="py-8 text-center text-xs text-slate-400">No late-paid spend.</p>}
        </Panel>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Scorecard */
function ScorecardTab({ data }: { data: VendorData }) {
  const rows = [...data.rows].sort((a, b) => b.score - a.score)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {data.gradeBreakdown.map((g) => (
          <div key={g.grade} className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <span className={cn('inline-grid h-9 w-9 place-items-center rounded-lg text-lg font-bold', GRADE_STYLE[g.grade])}>{g.grade}</span>
            <p className="mt-1.5 text-lg font-bold text-slate-900 tabular-nums dark:text-slate-100">{g.count}</p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">{money(g.spend)}</p>
          </div>
        ))}
      </div>
      <Panel title="Vendor Scorecard" icon={Star} hint="Relationship value — spend significance, engagement & stability" bodyClassName="p-0">
        <div className="max-h-[32rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Vendor</th>
                <th className="px-4 py-2 text-right font-medium">Spend</th>
                <th className="px-4 py-2 text-center font-medium">Tier</th>
                <th className="px-4 py-2 text-right font-medium">Bills</th>
                <th className="px-4 py-2 text-right font-medium">YoY</th>
                <th className="px-4 py-2 text-right font-medium">On-Time</th>
                <th className="px-4 py-2 text-right font-medium">Score</th>
                <th className="px-4 py-2 text-center font-medium">Grade</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.spend)}</td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{TIER_LABEL[r.tier]}</span></td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.bills}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', (r.yoyPct ?? 0) <= 0 ? 'text-slate-500 dark:text-slate-400' : 'text-amber-600 dark:text-amber-400')}>{r.yoyPct === null ? '—' : fmtPct(r.yoyPct)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.onTimePct === null ? '—' : fmtPct(r.onTimePct)}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums text-slate-800 dark:text-slate-200">{Math.round(r.score)}</td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded px-2 py-0.5 text-xs font-bold', GRADE_STYLE[r.grade])}>{r.grade}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------- Leverage Matrix */
function MatrixTab({ data }: { data: VendorData }) {
  const option = useMemo(() => matrixOption(data.rows), [data])
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.quadrantBreakdown.map((q) => (
          <div key={q.quadrant} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: QUADRANT[q.quadrant].color }} />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{QUADRANT[q.quadrant].label}</span>
            </div>
            <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums dark:text-slate-100">{q.count}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{money(q.spend)} · {QUADRANT[q.quadrant].desc}</p>
          </div>
        ))}
      </div>
      <Panel title="Leverage Matrix" icon={Grid2x2} hint="Spend (impact) × payment reliability (performance) — bubble size = spend">
        <Chart option={option} height={420} />
      </Panel>
    </div>
  )
}

function matrixOption(rows: VendorRow[]): Record<string, unknown> {
  const maxSpend = Math.max(1, ...rows.map((r) => r.spend))
  const byQuad = (q: Quadrant) =>
    rows.filter((r) => r.quadrant === q).map((r) => ({
      value: [Math.log10(Math.max(r.spend, 1)), r.performance, r.spend],
      name: r.name,
      symbolSize: 8 + 34 * Math.sqrt(r.spend / maxSpend),
      itemStyle: { color: QUADRANT[q].color, opacity: 0.75 },
    }))
  const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`)
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 28, containLabel: true },
    tooltip: { backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 }, formatter: (p: any) => `${p.data.name}<br/>Spend: ${money(p.data.value[2])}<br/>On-time: ${p.data.value[1].toFixed(0)}%` },
    xAxis: { type: 'value', name: 'Spend (log) →', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } }, axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (v: number) => money(Math.pow(10, v)) } },
    yAxis: { type: 'value', name: 'On-time %', min: 0, max: 100, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } }, axisLabel: { color: '#94a3b8', fontSize: 9 } },
    series: [
      { type: 'scatter', data: byQuad('strategic'), name: 'Strategic' },
      { type: 'scatter', data: byQuad('commodity'), name: 'Commodity' },
      { type: 'scatter', data: byQuad('niche'), name: 'Niche' },
      { type: 'scatter', data: byQuad('transactional'), name: 'Transactional' },
      { type: 'line', markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'dashed' }, data: [{ yAxis: 50 }] }, data: [] },
    ],
  }
}

/* ------------------------------------------------------------ Vendors table */
function VendorsTab({ data }: { data: VendorData }) {
  const [sort, setSort] = useState<keyof Pick<VendorRow, 'spend' | 'bills' | 'avgBill' | 'recencyDays' | 'score'>>('spend')
  const rows = [...data.rows].sort((a, b) => {
    const av = a[sort] ?? -1
    const bv = b[sort] ?? -1
    return sort === 'recencyDays' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
  const Th = ({ label, k }: { label: string; k?: typeof sort }) => (
    <th className="px-4 py-2 text-right font-medium">
      {k ? <button type="button" onClick={() => setSort(k)} className={cn('hover:text-slate-700 dark:hover:text-slate-300', sort === k && 'text-teal-600 dark:text-teal-400')}>{label}</button> : label}
    </th>
  )
  return (
    <Panel title={`All Vendors (${data.rows.length})`} icon={Table2} bodyClassName="p-0">
      <div className="max-h-[32rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Vendor</th>
              <Th label="Spend" k="spend" />
              <Th label="Share" />
              <Th label="Bills" k="bills" />
              <Th label="Avg Bill" k="avgBill" />
              <Th label="On-Time" />
              <Th label="Score" k="score" />
              <th className="px-4 py-2 text-center font-medium">Tier</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.spend)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(r.sharePct)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.bills}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(r.avgBill)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.onTimePct === null ? '—' : fmtPct(r.onTimePct)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-700 dark:text-slate-300">{Math.round(r.score)}</td>
                <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{TIER_LABEL[r.tier]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
