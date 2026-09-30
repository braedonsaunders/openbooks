'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import { useState } from 'react'
import { Network, PieChart, BarChart3 } from 'lucide-react'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData, SegmentRow } from '../../../../../lib/analytics/health-data'
import { Panel, SegToggle } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { Donut, GroupedBar } from '../../_ui/charts'
import { useAnalyticsMoney, fmtPct, ratioNumber, toChartNumber } from '../../_ui/format'
import { cmp, sum } from '@openbooks/engine/src/money/money.ts'

type Dim = 'department' | 'class' | 'location'

const HEALTH_DOT: Record<SegmentRow['health'], string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
}

export function SegmentsTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const [dim, setDim] = useState<Dim>('department')
  const rows = data.segments[dim]

  const options: { value: Dim; label: string }[] = [
    { value: 'department', label: 'By Department' },
    { value: 'class', label: 'By Class' },
    { value: 'location', label: 'By Location' },
  ]

  // Exact sums for display; HHI reuses the server-computed exact shares.
  const totalRev = sum(rows.map((r) => r.revenue))
  const totalOp = sum(rows.map((r) => r.operatingIncome))
  const best = rows.slice().sort((a, b) => b.operatingMarginPct - a.operatingMarginPct)[0]
  // the segment concentration: HHI = Σ(share×100)², classic 0–10,000
  // scale (Unconcentrated <1500 / Moderate <2500 / Concentrated).
  const hhi = Math.round(rows.reduce((a, r) => a + (r.sharePct * 100) ** 2, 0))
  const hhiLabel = hhi >= 2500 ? 'Concentrated' : hhi >= 1500 ? 'Moderate' : 'Unconcentrated'

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard icon={Network} accent="teal" label="Segments" value={String(rows.length)} sub={dim} />
        <KpiCard icon={BarChart3} accent="emerald" label="Total Revenue" value={fmtMoney(totalRev, { compact: true })} sub="across segments" />
        <KpiCard icon={BarChart3} accent="violet" label="Operating Income" value={fmtMoney(totalOp, { compact: true })} sub={fmtPct(cmp(totalRev, '0') > 0 ? ratioNumber(totalOp, totalRev) : 0)} />
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
                <SharedTable className="w-full text-sm">
                  <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                    <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                      <SharedTableHead className="w-6 px-2 py-2" />
                      <SharedTableHead className="px-3 py-2 text-left font-medium">Segment</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right font-medium">Revenue</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right font-medium">Share</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right font-medium">GM %</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right font-medium">Op %</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right font-medium">YoY</SharedTableHead>
                    </SharedTableRow>
                  </SharedTableHeader>
                  <SharedTableBody>
                    {rows.map((r) => (
                      <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                        <SharedTableCell className="px-2 py-2"><span className={cn('inline-block h-2 w-2 rounded-full', HEALTH_DOT[r.health])} /></SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(r.revenue, { compact: true })}</SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(r.sharePct)}</SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtPct(r.grossMarginPct)}</SharedTableCell>
                        <SharedTableCell className={cn('px-3 py-2 text-right tabular-nums', r.operatingMarginPct >= 0 ? 'text-slate-600 dark:text-slate-300' : 'text-red-600 dark:text-red-400')}>{fmtPct(r.operatingMarginPct)}</SharedTableCell>
                        <SharedTableCell className={cn('px-3 py-2 text-right tabular-nums', (r.yoyPct ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{r.yoyPct === null ? '—' : fmtPct(r.yoyPct)}</SharedTableCell>
                      </SharedTableRow>
                    ))}
                  </SharedTableBody>
                </SharedTable>
              </div>
            </Panel>
          </div>
          <div className="space-y-5">
            <Panel title="Revenue Mix" icon={PieChart}>
              <Donut data={rows.filter((r) => cmp(r.revenue, '0') > 0).map((r) => ({ name: r.name, value: toChartNumber(r.revenue) }))} height={200} />
            </Panel>
            <Panel title="Margin Comparison" icon={BarChart3}>
              <GroupedBar
                labels={rows.map((r) => r.name)}
                height={200}
                series={[
                  { name: 'Gross Profit', data: rows.map((r) => toChartNumber(r.grossProfit)), color: '#0d9488' },
                  { name: 'Operating Income', data: rows.map((r) => toChartNumber(r.operatingIncome)), color: '#f59e0b' },
                ]}
              />
            </Panel>
          </div>
        </div>
      )}
    </div>
  )
}
