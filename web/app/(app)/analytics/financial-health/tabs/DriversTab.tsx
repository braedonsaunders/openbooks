'use client'

import { Search, TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { HealthData, DriverRow } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { DivergingBar } from '../../_ui/charts'
import { fmtMoney, fmtPct } from '../../_ui/format'

export function DriversTab({ data, onDrill }: { data: HealthData; onDrill: (id: string, name: string) => void }) {
  const rev = data.drivers.revenue
  const cost = data.drivers.cost
  const revNet = rev.reduce((a, d) => a + d.change, 0)
  const costNet = cost.reduce((a, d) => a + d.change, 0)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={TrendingUp} accent={revNet >= 0 ? 'emerald' : 'red'} label="Revenue Movement" value={fmtMoney(revNet, { compact: true })} sub="net YoY change" tone={revNet >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={TrendingDown} accent={costNet <= 0 ? 'emerald' : 'red'} label="Cost Movement" value={fmtMoney(costNet, { compact: true })} sub="net YoY change" tone={costNet <= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Search} accent="teal" label="Top Rev Driver" value={rev[0] ? fmtMoney(rev[0].change, { compact: true }) : '—'} sub={rev[0]?.name ?? '—'} />
        <KpiCard icon={Search} accent="violet" label="Top Cost Driver" value={cost[0] ? fmtMoney(cost[0].change, { compact: true }) : '—'} sub={cost[0]?.name ?? '—'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DriverPanel title="Revenue Drivers" icon={TrendingUp} rows={rev} onDrill={onDrill} />
        <DriverPanel title="Cost Drivers" icon={TrendingDown} rows={cost} onDrill={onDrill} />
      </div>
    </div>
  )
}

function DriverPanel({ title, icon: Icon, rows, onDrill }: { title: string; icon: typeof Search; rows: DriverRow[]; onDrill: (id: string, name: string) => void }) {
  const top = rows.slice(0, 8)
  return (
    <Panel title={title} icon={Icon}>
      {top.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-400">No movement.</p>
      ) : (
        <>
          <DivergingBar labels={top.map((d) => d.name)} values={top.map((d) => d.change)} height={Math.max(180, top.length * 26)} />
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="py-1.5 text-left font-medium">Account</th>
                <th className="py-1.5 text-right font-medium">Current</th>
                <th className="py-1.5 text-right font-medium">Δ</th>
                <th className="py-1.5 text-right font-medium">Δ %</th>
                <th className="py-1.5 text-right font-medium">Contrib.</th>
              </tr>
            </thead>
            <tbody>
              {top.map((d) => (
                <tr key={d.id} onClick={() => onDrill(d.id, d.name)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="py-1.5 text-slate-700 dark:text-slate-300">{d.name}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(d.current, { compact: true })}</td>
                  <td className={cn('py-1.5 text-right tabular-nums', d.change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(d.change, { compact: true })}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{d.changePct === null ? '—' : fmtPct(d.changePct)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-400 dark:text-slate-500">{fmtPct(d.contribution)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  )
}
