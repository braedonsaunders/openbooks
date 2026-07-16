'use client'

import { useState } from 'react'
import {
  Users,
  Crown,
  Gem,
  AlertOctagon,
  BarChart3,
  PieChart as PieIcon,
  Layers,
  Trophy,
  Table2,
  DollarSign,
  FileText,
  HandCoins,
  Percent,
  ChevronRight,
  ChevronDown,
  FolderGit2,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import type {
  CustomerData,
  CustomerRow,
  Tier,
  ChurnBand,
  Profitability,
  ProfitTier,
} from '../../../../lib/analytics/customer-data'
import { Gauge } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { DivergingBar, Donut, GroupedBar } from '../_ui/charts'
import { fmtMoney, fmtPct } from '../_ui/format'

const TABS = ['overview', 'profitability', 'segmentation', 'lifetime', 'churn', 'customers'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  profitability: 'Profitability',
  segmentation: 'Segmentation',
  lifetime: 'Lifetime Value',
  churn: 'Churn Risk',
  customers: 'Customers',
}

// Profit-tier badge styling — ported from Gantry getProfitTierBadge.
const PROFIT_TIER_LABEL: Record<ProfitTier, string> = { high: 'High', medium: 'Medium', low: 'Low', marginal: 'Marginal', loss: 'Loss' }
const PROFIT_TIER_STYLE: Record<ProfitTier, string> = {
  high: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  medium: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  low: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  marginal: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  loss: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
// Margin text colour — ported from Gantry (>=40 green, <0 red, <10 amber, else default).
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
const CHURN_LABEL: Record<ChurnBand, string> = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At Risk', churned: 'Churned' }
const CHURN_STYLE: Record<ChurnBand, string> = {
  healthy: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  watch: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  at_risk: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  churned: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
const CHURN_COLOR: Record<ChurnBand, string> = { healthy: '#10b981', watch: '#14b8a6', at_risk: '#f59e0b', churned: '#ef4444' }

export function CustomerView({ data, profitability }: { data: CustomerData; profitability: Profitability }) {
  const [tab, setTab] = useState<Tab>('overview')
  const t = data.totals
  const healthScore = t.healthScore

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={healthScore} label={healthScore >= 80 ? 'Excellent' : healthScore >= 60 ? 'Good' : healthScore >= 40 ? 'Fair' : 'At Risk'} size={132} thickness={12} showTicks={false} />
        </div>
        <KpiCard icon={Users} accent="sky" label="Total Customers" value={String(t.customers)} sub="in period" />
        <KpiCard icon={Crown} accent="violet" label="Champions" value={String(t.champions)} sub="platinum tier" />
        <KpiCard icon={Gem} accent="amber" label="Projected CLV" value={fmtMoney(t.projectedClv, { compact: true })} sub="3-year" />
        <KpiCard icon={AlertOctagon} accent="red" label="At Risk" value={String(t.atRisk)} sub={fmtMoney(t.atRiskRevenue, { compact: true })} tone="negative" />
      </div>

      {/* Tabs */}
      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors',
                tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'profitability' ? <ProfitabilityTab p={profitability} /> : null}
        {tab === 'segmentation' ? <SegmentationTab data={data} /> : null}
        {tab === 'lifetime' ? <LifetimeTab data={data} /> : null}
        {tab === 'churn' ? <ChurnTab data={data} /> : null}
        {tab === 'customers' ? <CustomersTab data={data} /> : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- Profitability */
type ProfitSort = 'customerName' | 'totalRevenue' | 'totalCost' | 'grossProfit' | 'marginPct'
const PAGE_SIZE = 20

function ProfitabilityTab({ p }: { p: Profitability }) {
  const s = p.summary
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sortCol, setSortCol] = useState<ProfitSort>('totalRevenue')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const money = (n: number) => fmtMoney(n, { compact: true })

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
      {/* KPI row */}
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
        <Panel title="Customer Profitability" icon={Users} hint="Click a customer to expand jobs" bodyClassName="p-0">
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
                    <FragmentRows key={c.customerId} isOpen={isOpen}>
                      <tr
                        className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                        onClick={() => toggle(c.customerId)}
                      >
                        <td className="px-2 py-2.5 text-center text-slate-400">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{c.customerName}</span>
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
                    </FragmentRows>
                  )
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <span>Showing {start + 1}–{Math.min(start + PAGE_SIZE, sorted.length)} of {sorted.length} customers</span>
              <div className="flex items-center gap-1">
                <button type="button" disabled={pageNo <= 1} onClick={() => setPage(pageNo - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Prev</button>
                <span className="px-2 tabular-nums">{pageNo} / {totalPages}</span>
                <button type="button" disabled={pageNo >= totalPages} onClick={() => setPage(pageNo + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Next</button>
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}

// <tbody> can't contain a Fragment array cleanly across React versions when
// keyed rows mix; a keyed wrapper component keeps the customer + its job rows
// grouped without an invalid DOM node.
function FragmentRows({ children }: { isOpen: boolean; children: React.ReactNode }) {
  return <>{children}</>
}

/* --------------------------------------------------------------- Overview */
function OverviewTab({ data }: { data: CustomerData }) {
  const t = data.totals
  const top = data.rows.slice(0, 10)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={BarChart3} accent="emerald" label="Total Revenue" value={fmtMoney(t.revenue, { compact: true })} sub={t.yoyPct === null ? 'in period' : `YoY ${fmtPct(t.yoyPct)}`} tone={(t.yoyPct ?? 0) >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Trophy} accent="teal" label="Top Customer" value={top[0] ? fmtMoney(top[0].revenue, { compact: true }) : '—'} sub={top[0]?.name ?? '—'} />
        <KpiCard icon={PieIcon} accent="violet" label="Top 5 Share" value={fmtPct(t.top5SharePct)} sub="revenue concentration" />
        <KpiCard icon={Layers} accent="amber" label="Concentration (HHI)" value={t.hhi.toFixed(3)} sub={t.hhi > 0.25 ? 'highly concentrated' : t.hhi > 0.15 ? 'moderate' : 'diversified'} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Top Customers by Revenue" icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => r.revenue)} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title="Revenue by Tier" icon={PieIcon}>
          <Donut data={data.tierBreakdown.filter((x) => x.revenue > 0).map((x) => ({ name: TIER_LABEL[x.tier], value: x.revenue }))} height={220} />
        </Panel>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- Segmentation */
function SegmentationTab({ data }: { data: CustomerData }) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel title="Customer Tiers (RFM)" icon={Layers} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Tier</th>
                <th className="px-4 py-2 text-right font-medium">Customers</th>
                <th className="px-4 py-2 text-right font-medium">Revenue</th>
                <th className="px-4 py-2 text-right font-medium">Share</th>
                <th className="px-4 py-2 text-right font-medium">Avg / Customer</th>
              </tr>
            </thead>
            <tbody>
              {data.tierBreakdown.map((x) => (
                <tr key={x.tier} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[x.tier])}>{TIER_LABEL[x.tier]}</span></td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{x.count}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(x.revenue, { compact: true })}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(data.totals.revenue > 0 ? x.revenue / data.totals.revenue : 0)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{x.count > 0 ? fmtMoney(x.revenue / x.count, { compact: true }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title="Tier Distribution" icon={PieIcon}>
        <Donut data={data.tierBreakdown.filter((x) => x.count > 0).map((x) => ({ name: TIER_LABEL[x.tier], value: x.count }))} height={220} />
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">Tiers are assigned by monetary rank; RFM scores combine recency, frequency and monetary value (see Customers tab).</p>
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------- Lifetime */
function LifetimeTab({ data }: { data: CustomerData }) {
  const leaders = [...data.rows].sort((a, b) => b.clv - a.clv).slice(0, 12)
  const byTier = data.tierBreakdown.map((x) => ({
    tier: x.tier,
    clv: data.rows.filter((r) => r.tier === x.tier).reduce((a, r) => a + r.clv, 0),
  }))
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel title="Lifetime Value Leaders" icon={Gem} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-right font-medium">Revenue</th>
                <th className="px-4 py-2 text-right font-medium">Projected CLV</th>
                <th className="px-4 py-2 text-center font-medium">Tier</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">{r.name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(r.revenue, { compact: true })}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(r.clv, { compact: true })}</td>
                  <td className="px-4 py-2.5 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{TIER_LABEL[r.tier]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title="Projected CLV by Tier" icon={BarChart3}>
        <GroupedBar labels={byTier.map((x) => TIER_LABEL[x.tier])} height={240} series={[{ name: 'Projected CLV', data: byTier.map((x) => x.clv), color: '#0d9488' }]} />
      </Panel>
    </div>
  )
}

/* --------------------------------------------------------------- Churn */
function ChurnTab({ data }: { data: CustomerData }) {
  const atRisk = data.rows.filter((r) => r.churn === 'at_risk' || r.churn === 'churned').sort((a, b) => b.revenue - a.revenue).slice(0, 15)
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel title="At-Risk Customers" icon={AlertOctagon} hint="Ranked by revenue at stake" bodyClassName="p-0">
          {atRisk.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">No at-risk customers — retention looks healthy.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 text-right font-medium">Last Invoice</th>
                  <th className="px-4 py-2 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {atRisk.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">{r.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(r.revenue, { compact: true })}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays === null ? '—' : `${r.recencyDays}d ago`}</td>
                    <td className="px-4 py-2.5 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', CHURN_STYLE[r.churn])}>{CHURN_LABEL[r.churn]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <Panel title="Churn Distribution" icon={PieIcon}>
        <Donut data={data.churnBreakdown.filter((x) => x.count > 0).map((x) => ({ name: CHURN_LABEL[x.band], value: x.count }))} height={200} />
        <ul className="mt-3 space-y-1.5">
          {data.churnBreakdown.map((x) => (
            <li key={x.band} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CHURN_COLOR[x.band] }} />
                {CHURN_LABEL[x.band]}
              </span>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">{x.count} · {fmtMoney(x.revenue, { compact: true })}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------ Customers */
function CustomersTab({ data }: { data: CustomerData }) {
  const [sort, setSort] = useState<keyof Pick<CustomerRow, 'revenue' | 'invoices' | 'clv' | 'recencyDays'>>('revenue')
  const rows = [...data.rows].sort((a, b) => {
    const av = a[sort] ?? -1
    const bv = b[sort] ?? -1
    return sort === 'recencyDays' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
  const Th = ({ label, k }: { label: string; k?: typeof sort }) => (
    <th className="px-4 py-2 text-right font-medium">
      {k ? (
        <button type="button" onClick={() => setSort(k)} className={cn('hover:text-slate-700 dark:hover:text-slate-300', sort === k && 'text-teal-600 dark:text-teal-400')}>{label}</button>
      ) : label}
    </th>
  )
  return (
    <Panel title={`All Customers (${data.rows.length})`} icon={Table2} bodyClassName="p-0">
      <div className="max-h-[32rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Customer</th>
              <Th label="Revenue" k="revenue" />
              <Th label="Share" />
              <Th label="Invoices" k="invoices" />
              <Th label="Recency" k="recencyDays" />
              <Th label="Avg Invoice" />
              <Th label="CLV" k="clv" />
              <th className="px-4 py-2 text-center font-medium">Tier</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(r.revenue, { compact: true })}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(r.sharePct)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.invoices}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.recencyDays === null ? '—' : `${r.recencyDays}d`}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(r.avgInvoice, { compact: true })}</td>
                <td className="px-4 py-2 text-right tabular-nums text-teal-600 dark:text-teal-400">{fmtMoney(r.clv, { compact: true })}</td>
                <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{TIER_LABEL[r.tier]}</span></td>
                <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', CHURN_STYLE[r.churn])}>{CHURN_LABEL[r.churn]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
