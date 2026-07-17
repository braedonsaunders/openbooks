'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardList, ArrowUpRight, Download, Search, Info } from 'lucide-react'
import { cn, Input } from '@openbooks/ui'
import type { HealthData, BudgetRow } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { GroupedBar } from '../../_ui/charts'
import { exportCsv } from '../../_ui/exportCsv'
import { fmtMoney, fmtPct } from '../../_ui/format'

const STATUS_LABEL: Record<BudgetRow['status'], string> = {
  'on-track': 'On Track',
  watch: 'Watch',
  over: 'Over',
  'no-budget': 'No Budget',
}
const STATUS_STYLE: Record<BudgetRow['status'], string> = {
  'on-track': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  watch: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  over: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  'no-budget': 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
}

/**
 * Budget vs Actual. Real mode when a budget scenario covers the period
 * (per-account variance from budget_lines); benchmark fallback otherwise,
 * clearly labelled — never silently synthetic.
 */
export function BudgetTab({ data }: { data: HealthData }) {
  return data.budget.scenario ? <RealBudget data={data} /> : <BenchmarkFallback data={data} />
}

/* ------------------------------------------------------------ real budgets */
type Filter = 'all' | 'over' | 'watch' | 'on-track' | 'no-budget'
const PAGE = 30

function RealBudget({ data }: { data: HealthData }) {
  const b = data.budget
  const scenario = b.scenario!
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return b.rows.filter((r) => (filter === 'all' || r.status === filter) && (!needle || r.name.toLowerCase().includes(needle)))
  }, [b.rows, filter, query])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const pageNo = Math.min(page, totalPages)
  const pageRows = filtered.slice((pageNo - 1) * PAGE, pageNo * PAGE)

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: b.rows.length, over: 0, watch: 0, 'on-track': 0, 'no-budget': 0 }
    for (const r of b.rows) c[r.status]++
    return c
  }, [b.rows])

  const budgeted = b.rows.filter((r) => r.status !== 'no-budget')
  const overCount = counts.over
  const coverage = b.rows.length ? budgeted.length / b.rows.length : 0

  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 rounded-lg bg-teal-50 p-3 text-xs leading-relaxed text-teal-800 dark:bg-teal-950/30 dark:text-teal-300">
        <ClipboardList size={14} className="mt-0.5 shrink-0" />
        <span>
          Measured against <span className="font-semibold">{scenario.name}</span> (FY{scenario.fiscalYear}, {scenario.status}) — budget lines summed over the periods
          overlapping this range. Manage scenarios in <Link href="/reports/budget" className="font-semibold underline">Reports → Budget</Link>.
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={ClipboardList} accent="teal" label="Total Budget" value={fmtMoney(b.totals.budget, { compact: true })} sub={`${budgeted.length} budgeted accounts`} />
        <KpiCard icon={ClipboardList} accent="sky" label="Total Actual" value={fmtMoney(b.totals.actual, { compact: true })} sub="income sign-normalised" />
        <KpiCard icon={ClipboardList} accent={overCount > 0 ? 'red' : 'emerald'} label="Over Budget" value={String(overCount)} sub={`${counts.watch} on watch`} tone={overCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={ClipboardList} accent="violet" label="Coverage" value={fmtPct(coverage)} sub="accounts with a budget line" />
      </div>

      <Panel
        title={`Budget vs Actual (${filtered.length})`}
        icon={ClipboardList}
        bodyClassName="p-0"
        actions={
          <span className="flex items-center gap-2">
            <span className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
              <Input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1) }} placeholder="Search accounts…" className="h-7 w-44 pl-8 text-xs" />
            </span>
            <button
              type="button"
              onClick={() => exportCsv('budget-vs-actual', ['Account', 'Type', 'Budget', 'Actual', 'Variance', 'Variance %', 'Status'], filtered.map((r) => [r.name, r.type, Math.round(r.budget), Math.round(r.actual), Math.round(r.variance), r.variancePct === null ? '' : (r.variancePct * 100).toFixed(1), STATUS_LABEL[r.status]]))}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <Download size={11} /> CSV
            </button>
          </span>
        }
      >
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
          {(Object.keys(counts) as Filter[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => { setFilter(k); setPage(1) }}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium',
                filter === k ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400',
              )}
            >
              {k === 'all' ? 'All' : STATUS_LABEL[k as BudgetRow['status']]} ({counts[k]})
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Account</th>
                <th className="px-4 py-2 text-right font-medium">Budget</th>
                <th className="px-4 py-2 text-right font-medium">Actual</th>
                <th className="w-40 px-4 py-2 text-left font-medium">Progress</th>
                <th className="px-4 py-2 text-right font-medium">Variance</th>
                <th className="px-4 py-2 text-center font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const ratio = Math.abs(r.budget) > 0.005 ? Math.max(0, r.actual / r.budget) : null
                return (
                  <tr key={r.accountId} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.status === 'no-budget' ? '—' : fmtMoney(r.budget, { compact: true })}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(r.actual, { compact: true })}</td>
                    <td className="px-4 py-2">
                      {ratio === null ? (
                        <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                            <span className={cn('block h-full rounded-full', r.status === 'over' ? 'bg-red-500' : r.status === 'watch' ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                          </span>
                          <span className="text-[11px] tabular-nums text-slate-400">{Math.round(ratio * 100)}%</span>
                        </span>
                      )}
                    </td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', r.status === 'no-budget' ? 'text-slate-400 dark:text-slate-500' : r.favorable ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {r.status === 'no-budget' ? '—' : `${r.variance >= 0 ? '+' : ''}${fmtMoney(r.variance, { compact: true })}`}
                    </td>
                    <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS_STYLE[r.status])}>{STATUS_LABEL[r.status]}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span>Showing {(pageNo - 1) * PAGE + 1}–{Math.min(pageNo * PAGE, filtered.length)} of {filtered.length} accounts</span>
            <span className="flex items-center gap-1">
              <button type="button" disabled={pageNo <= 1} onClick={() => setPage(pageNo - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Prev</button>
              <span className="px-2 tabular-nums">{pageNo} / {totalPages}</span>
              <button type="button" disabled={pageNo >= totalPages} onClick={() => setPage(pageNo + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Next</button>
            </span>
          </div>
        )}
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------ benchmark fallback */
function BenchmarkFallback({ data }: { data: HealthData }) {
  const f = data.figures
  const rev = f.revenue
  const lines = [
    { key: 'gp', label: 'Gross Profit', budget: rev * 0.4, actual: f.grossProfit, favorableWhenOver: true },
    { key: 'cogs', label: 'Cost of Goods Sold', budget: rev * 0.6, actual: f.cogs, favorableWhenOver: false },
    { key: 'opex', label: 'Operating Expenses', budget: rev * 0.25, actual: f.opex, favorableWhenOver: false },
    { key: 'opinc', label: 'Operating Income', budget: rev * 0.15, actual: f.operatingIncome, favorableWhenOver: true },
  ].map((l) => {
    const variance = l.actual - l.budget
    const favorable = l.favorableWhenOver ? variance >= 0 : variance <= 0
    return { ...l, variance, favorable, pct: l.budget !== 0 ? l.actual / l.budget : 0 }
  })
  const favorableCount = lines.filter((l) => l.favorable).length

  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          <span className="font-semibold">No budget scenario covers this period</span> — showing benchmark targets (40% gross / 25% opex / 15% operating of actual revenue)
          instead. Create one in <Link href="/reports/budget" className="font-semibold underline">Reports → Budget</Link> for real per-account variance.
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={ClipboardList} accent="teal" label="Lines On Target" value={`${favorableCount}/${lines.length}`} sub="favorable vs benchmark" />
        <KpiCard icon={ClipboardList} accent={lines[0].favorable ? 'emerald' : 'red'} label="Gross Profit vs Target" value={fmtMoney(lines[0].variance, { compact: true })} sub={fmtPct(lines[0].pct - 1)} tone={lines[0].favorable ? 'positive' : 'negative'} />
        <KpiCard icon={ClipboardList} accent={lines[2].favorable ? 'emerald' : 'red'} label="OpEx vs Target" value={fmtMoney(lines[2].variance, { compact: true })} sub={fmtPct(lines[2].pct - 1)} tone={lines[2].favorable ? 'positive' : 'negative'} />
        <KpiCard icon={ClipboardList} accent={lines[3].favorable ? 'emerald' : 'red'} label="Op Income vs Target" value={fmtMoney(lines[3].variance, { compact: true })} sub={fmtPct(lines[3].pct - 1)} tone={lines[3].favorable ? 'positive' : 'negative'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Target vs Actual" icon={ClipboardList} bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Line</th>
                  <th className="px-4 py-2 text-right font-medium">Target</th>
                  <th className="px-4 py-2 text-right font-medium">Actual</th>
                  <th className="px-4 py-2 text-right font-medium">Variance</th>
                  <th className="px-4 py-2 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">{l.label}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(l.budget)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(l.actual)}</td>
                    <td className={cn('px-4 py-2.5 text-right tabular-nums', l.favorable ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(l.variance)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', l.favorable ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300')}>
                        {l.favorable ? 'On target' : 'Off target'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel title="Target vs Actual" icon={ClipboardList}>
            <GroupedBar
              labels={lines.map((l) => l.label)}
              height={220}
              series={[
                { name: 'Target', data: lines.map((l) => l.budget), color: '#94a3b8' },
                { name: 'Actual', data: lines.map((l) => l.actual), color: '#0d9488' },
              ]}
            />
          </Panel>
          <Link
            href="/reports/budget"
            className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-teal-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-700"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-teal-50 text-teal-600 ring-1 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300">
              <ClipboardList size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Formal budgets</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">Budget scenarios &amp; variance in Reports</p>
            </div>
            <ArrowUpRight size={15} className="text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-teal-600 dark:text-slate-600" />
          </Link>
        </div>
      </div>
    </div>
  )
}
