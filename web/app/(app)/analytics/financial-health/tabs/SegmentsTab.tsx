'use client'

import { useState } from 'react'
import { Network, PieChart, BarChart3, Table2 } from 'lucide-react'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData, SegmentRow } from '../../../../../lib/analytics/health-data'
import { Panel, SegToggle } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { Donut, GroupedBar } from '../../_ui/charts'
import { fmtMoney, fmtPct } from '../../_ui/format'

type Dim = 'department' | 'class' | 'location'

const HEALTH_DOT: Record<SegmentRow['health'], string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
}

export function SegmentsTab({ data }: { data: HealthData }) {
  const [dim, setDim] = useState<Dim>('department')
  const rows = data.segments[dim]

  const options: { value: Dim; label: string }[] = [
    { value: 'department', label: 'By Department' },
    { value: 'class', label: 'By Class' },
    { value: 'location', label: 'By Location' },
  ]

  const totalRev = rows.reduce((a, r) => a + r.revenue, 0)
  const totalOp = rows.reduce((a, r) => a + r.operatingIncome, 0)
  const best = rows.slice().sort((a, b) => b.operatingMarginPct - a.operatingMarginPct)[0]
  // Gantry's segment concentration: HHI = Σ(share×100)², classic 0–10,000
  // scale (Unconcentrated <1500 / Moderate <2500 / Concentrated).
  const hhi = Math.round(rows.reduce((a, r) => a + (totalRev > 0 ? (r.revenue / totalRev) * 100 : 0) ** 2, 0))
  const hhiLabel = hhi >= 2500 ? 'Concentrated' : hhi >= 1500 ? 'Moderate' : 'Unconcentrated'

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard icon={Network} accent="teal" label="Segments" value={String(rows.length)} sub={dim} />
        <KpiCard icon={BarChart3} accent="emerald" label="Total Revenue" value={fmtMoney(totalRev, { compact: true })} sub="across segments" />
        <KpiCard icon={BarChart3} accent="violet" label="Operating Income" value={fmtMoney(totalOp, { compact: true })} sub={fmtPct(totalRev > 0 ? totalOp / totalRev : 0)} />
        <KpiCard icon={PieChart} accent="amber" label="Best Margin" value={best ? fmtPct(best.operatingMarginPct) : '—'} sub={best?.name ?? '—'} />
        <KpiCard icon={Network} accent={hhi >= 2500 ? 'red' : hhi >= 1500 ? 'amber' : 'emerald'} label="Concentration (HHI)" value={String(hhi)} sub={hhiLabel} tone={hhi >= 2500 ? 'negative' : 'neutral'} />
      </div>

      <div className="flex justify-end">
        <SegToggle value={dim} onChange={setDim} options={options} />
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<Network size={28} />} title="No segment data" description={`No ${dim} dimension is tagged on the ledger lines for this period.`} />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel title="Segment Performance" icon={Network} bodyClassName="p-0">
              <div className="max-h-[28rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white dark:bg-slate-900">
                    <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                      <th className="w-6 px-2 py-2" />
                      <th className="px-3 py-2 text-left font-medium">Segment</th>
                      <th className="px-3 py-2 text-right font-medium">Revenue</th>
                      <th className="px-3 py-2 text-right font-medium">Share</th>
                      <th className="px-3 py-2 text-right font-medium">GM %</th>
                      <th className="px-3 py-2 text-right font-medium">Op %</th>
                      <th className="px-3 py-2 text-right font-medium">YoY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                        <td className="px-2 py-2"><span className={cn('inline-block h-2 w-2 rounded-full', HEALTH_DOT[r.health])} /></td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(r.revenue, { compact: true })}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(r.sharePct)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtPct(r.grossMarginPct)}</td>
                        <td className={cn('px-3 py-2 text-right tabular-nums', r.operatingMarginPct >= 0 ? 'text-slate-600 dark:text-slate-300' : 'text-red-600 dark:text-red-400')}>{fmtPct(r.operatingMarginPct)}</td>
                        <td className={cn('px-3 py-2 text-right tabular-nums', (r.yoyPct ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{r.yoyPct === null ? '—' : fmtPct(r.yoyPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          <div className="space-y-5">
            <Panel title="Revenue Mix" icon={PieChart}>
              <Donut data={rows.filter((r) => r.revenue > 0).map((r) => ({ name: r.name, value: r.revenue }))} height={200} />
            </Panel>
            <Panel title="Margin Comparison" icon={BarChart3}>
              <GroupedBar
                labels={rows.map((r) => r.name)}
                height={200}
                series={[
                  { name: 'Gross Profit', data: rows.map((r) => r.grossProfit), color: '#0d9488' },
                  { name: 'Operating Income', data: rows.map((r) => r.operatingIncome), color: '#f59e0b' },
                ]}
              />
            </Panel>
          </div>
        </div>
      )}
    </div>
  )
}
