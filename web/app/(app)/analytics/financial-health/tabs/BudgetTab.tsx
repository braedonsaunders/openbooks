'use client'

import Link from 'next/link'
import { ClipboardList, ArrowUpRight } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { GroupedBar } from '../../_ui/charts'
import { fmtMoney, fmtPct } from '../../_ui/format'

/**
 * Target vs Actual. Formal budget scenarios live in Reports → Budget; this tab
 * measures performance against the health benchmarks (40% gross, 25% opex, 15%
 * operating) applied to actual revenue — a budget-style variance view that
 * works even without a configured budget scenario.
 */
export function BudgetTab({ data }: { data: HealthData }) {
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
                  <th className="px-4 py-2 text-right font-medium">Budget</th>
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
          <Panel title="Budget vs Actual" icon={ClipboardList}>
            <GroupedBar
              labels={lines.map((l) => l.label)}
              height={220}
              series={[
                { name: 'Budget', data: lines.map((l) => l.budget), color: '#94a3b8' },
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
