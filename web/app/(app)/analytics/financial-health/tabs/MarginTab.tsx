'use client'

import { Layers, Percent, AreaChart, PieChart, ArrowLeftRight, Waypoints } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { Waterfall, TrendChart, Donut } from '../../_ui/charts'
import { useAnalyticsMoney, fmtPct } from '../../_ui/format'

export function MarginTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const f = data.figures
  const rev = f.revenue || 1
  const gmPct = f.grossProfit / rev
  const opPct = f.operatingIncome / rev
  const netPct = f.netIncome / rev

  const pnl = Object.fromEntries(data.pnlSummary.map((l) => [l.key, l]))
  // the GM volume/rate bridge: volume effect = ΔRevenue × prior GM%,
  // rate effect = current Revenue × ΔGM%. The two effects reconcile prior
  // gross margin to current exactly.
  const priorRev = pnl.revenue?.prior ?? 0
  const priorGP = pnl.grossProfit?.prior ?? 0
  const curGP = pnl.grossProfit?.current ?? 0
  const priorGmPct = priorRev > 0 ? priorGP / priorRev : 0
  const volumeEffect = ((pnl.revenue?.change ?? 0)) * priorGmPct
  const rateEffect = rev * (gmPct - priorGmPct)
  const bridgeSteps: { label: string; amount: number; kind: 'start' | 'deduct' | 'subtotal' | 'total' }[] = [
    { label: 'Prior GM', amount: priorGP, kind: 'start' },
    { label: 'Volume Effect', amount: volumeEffect, kind: 'deduct' },
    { label: 'Rate Effect', amount: rateEffect, kind: 'deduct' },
    { label: 'Current GM', amount: curGP, kind: 'total' },
  ]

  const allocation = [
    { name: 'COGS', value: Math.max(0, f.cogs) },
    { name: 'Operating Expenses', value: Math.max(0, f.opex) },
    { name: 'Other Expense', value: Math.max(0, f.otherExpense) },
    { name: 'Net Income', value: Math.max(0, f.netIncome) },
  ].filter((d) => d.value > 0)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Percent} accent="teal" label="Gross Margin" value={fmtPct(gmPct)} sub={fmtMoney(f.grossProfit, { compact: true })} />
        <KpiCard icon={Percent} accent="violet" label="Operating Margin" value={fmtPct(opPct)} sub={fmtMoney(f.operatingIncome, { compact: true })} />
        <KpiCard icon={Percent} accent={netPct >= 0 ? 'emerald' : 'red'} label="Net Margin" value={fmtPct(netPct)} sub={fmtMoney(f.netIncome, { compact: true })} tone={netPct >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Layers} accent="amber" label="COGS Ratio" value={fmtPct(f.cogs / rev)} sub={fmtMoney(f.cogs, { compact: true })} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Margin Flow Analysis" icon={Waypoints} hint="Revenue → Net Income">
            <Waterfall steps={data.marginFlow.map((s) => ({ label: s.label, amount: s.amount, kind: s.kind }))} height={260} />
          </Panel>
        </div>
        <Panel title="Margin Summary" icon={Percent} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.marginFlow.map((s) => (
              <li key={s.key} className="flex items-center justify-between px-4 py-2.5">
                <span className={cn('text-sm', s.kind === 'subtotal' || s.kind === 'total' || s.kind === 'start' ? 'font-semibold text-slate-800 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400')}>{s.label}</span>
                <span className="flex items-baseline gap-2">
                  <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{fmtMoney(s.amount, { compact: true })}</span>
                  <span className="w-12 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{fmtPct(s.pctOfRevenue)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title="YoY Margin Bridge"
            icon={ArrowLeftRight}
            hint={`Volume = ΔRevenue × prior GM% · Rate = revenue × ΔGM% (${fmtPct(priorGmPct)} → ${fmtPct(gmPct)})`}
          >
            <Waterfall steps={bridgeSteps} height={220} />
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel title="Margin Trends (12mo)" icon={AreaChart}>
            <TrendChart
              labels={data.monthly.map((p) => p.label)}
              pctAxis
              height={130}
              series={[
                { name: 'Gross', data: data.monthly.map((p) => p.grossMarginPct), color: '#0d9488', pct: true },
                { name: 'Operating', data: data.monthly.map((p) => p.operatingMarginPct), color: '#f59e0b', pct: true },
              ]}
            />
          </Panel>
          <Panel title="Revenue Allocation" icon={PieChart}>
            {allocation.length ? <Donut data={allocation} height={150} /> : <p className="py-6 text-center text-xs text-slate-400">No allocation data.</p>}
          </Panel>
        </div>
      </div>
    </div>
  )
}
