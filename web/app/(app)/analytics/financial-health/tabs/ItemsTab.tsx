'use client'

import { useState } from 'react'
import { Boxes, ArrowUp, ArrowDown, Table2, BarChart3 } from 'lucide-react'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData, ItemRow } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { DivergingBar } from '../../_ui/charts'
import { fmtMoney, fmtPct } from '../../_ui/format'

type SortKey = 'current' | 'change' | 'changePct' | 'contribution'

export function ItemsTab({ data, onDrill }: { data: HealthData; onDrill: (id: string, name: string) => void }) {
  const [sort, setSort] = useState<SortKey>('current')
  const { rows, gainers, decliners, totalCurrent, totalChange } = data.items

  if (!rows.length) {
    return (
      <EmptyState
        icon={<Boxes size={28} />}
        title="No item-level revenue"
        description="No income accounts posted in this period to break down by line item."
      />
    )
  }

  const sorted = [...rows].sort((a, b) => Math.abs(b[sort] ?? 0) - Math.abs(a[sort] ?? 0))
  const topMovers = [...rows].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Boxes} accent="teal" label="Revenue Lines" value={String(rows.length)} sub="income accounts" />
        <KpiCard icon={BarChart3} accent="emerald" label="Total Revenue" value={fmtMoney(totalCurrent, { compact: true })} sub="current period" />
        <KpiCard icon={ArrowUp} accent={totalChange >= 0 ? 'emerald' : 'red'} label="Net Change" value={fmtMoney(totalChange, { compact: true })} sub="vs prior year" tone={totalChange >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={ArrowUp} accent="violet" label="Top Gainer" value={gainers[0] ? fmtMoney(gainers[0].change, { compact: true }) : '—'} sub={gainers[0]?.name ?? '—'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title="Revenue Line Changes (YoY)" icon={BarChart3}>
            <DivergingBar labels={topMovers.map((i) => i.name)} values={topMovers.map((i) => i.change)} height={Math.max(200, topMovers.length * 26)} />
          </Panel>
          <Panel title="Line-Item Analysis" icon={Table2} bodyClassName="p-0">
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Item</th>
                    <Th label="Prior" onClick={() => setSort('current')} active={false} />
                    <Th label="Current" onClick={() => setSort('current')} active={sort === 'current'} />
                    <Th label="Δ" onClick={() => setSort('change')} active={sort === 'change'} />
                    <Th label="Δ %" onClick={() => setSort('changePct')} active={sort === 'changePct'} />
                    <Th label="Contribution" onClick={() => setSort('contribution')} active={sort === 'contribution'} />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((it) => (
                    <tr key={it.id} onClick={() => onDrill(it.id, it.name)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{it.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(it.prior)}</td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(it.current)}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', it.change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(it.change)}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', (it.changePct ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{it.changePct === null ? '—' : fmtPct(it.changePct)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(it.contribution)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        <div className="space-y-5">
          <MoversPanel title="Top Gainers" icon={ArrowUp} accent="emerald" rows={gainers} />
          <MoversPanel title="Top Decliners" icon={ArrowDown} accent="red" rows={decliners} />
        </div>
      </div>
    </div>
  )
}

function Th({ label, onClick, active }: { label: string; onClick: () => void; active: boolean }) {
  return (
    <th className="px-4 py-2 text-right font-medium">
      <button type="button" onClick={onClick} className={cn('hover:text-slate-700 dark:hover:text-slate-300', active && 'text-teal-600 dark:text-teal-400')}>
        {label}
      </button>
    </th>
  )
}

function MoversPanel({ title, icon: Icon, accent, rows }: { title: string; icon: typeof ArrowUp; accent: 'emerald' | 'red'; rows: ItemRow[] }) {
  return (
    <Panel title={title} icon={Icon} bodyClassName="p-0">
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-slate-400">None.</p>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-300">{r.name}</span>
              <span className={cn('shrink-0 text-sm font-medium tabular-nums', accent === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(r.change, { compact: true })}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
