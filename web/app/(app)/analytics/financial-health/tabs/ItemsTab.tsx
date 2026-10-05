'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import { useMemo, useState } from 'react'
import { Boxes, ArrowUp, ArrowDown, Table2, BarChart3 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData, ItemRow } from '../../../../../lib/analytics/health-data'
import { abs, cmp } from '@openbooks/engine/money'
import { InteractiveTableRow } from '@/components/interactive-table-row'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { DivergingBar } from '../../_ui/charts'
import { useAnalyticsMoney, toChartNumber } from '../../_ui/format'

type SortKey = 'prior' | 'current' | 'change' | 'changePct' | 'contribution'

export function ItemsTab({ data, onDrill }: { data: HealthData; onDrill: (id: string, name: string) => void }) {
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const t = useTranslations('analytics.financialHealth.items')
  const pctN = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)
  const [sort, setSort] = useState<SortKey>('current')
  const { rows, gainers, decliners, totalCurrent, totalChange } = data.items

  // Money keys sort by exact magnitude — never through Number. Percent keys
  // are display ratios; nulls sort last so unranked lines never lead.
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    if (sort === 'changePct') return (b.changePct ?? Number.NEGATIVE_INFINITY) - (a.changePct ?? Number.NEGATIVE_INFINITY)
    if (sort === 'contribution') return b.contribution - a.contribution
    return cmp(abs(b[sort]), abs(a[sort]))
  }), [rows, sort])
  const topMovers = useMemo(() => {
    const all = [...data.items.gainers, ...data.items.decliners]
    // Rank by exact money magnitude — never through the chart projection.
    return all.sort((a, b) => cmp(abs(b.change), abs(a.change))).slice(0, 10)
  }, [data.items])
  const topGainer = data.items.gainers[0]
  const netTone = cmp(totalChange, '0') >= 0 ? 'positive' : 'negative'

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Boxes} accent="teal" label={t('kpi.lines')} value={String(rows.length)} sub={t('kpiSub.lines')} />
        <KpiCard icon={BarChart3} accent="emerald" label={t('kpi.total')} value={fmtMoney(totalCurrent)} sub={t('kpiSub.total')} />
        <KpiCard icon={ArrowUp} accent={netTone === 'positive' ? 'emerald' : 'red'} label={t('kpi.net')} value={fmtMoney(totalChange)} sub={t('kpiSub.net')} tone={netTone} />
        <KpiCard icon={ArrowUp} accent="violet" label={t('kpi.topGainer')} value={topGainer ? fmtMoney(topGainer.change) : '—'} sub={topGainer?.name ?? '—'} tone={topGainer ? 'positive' : 'neutral'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title={t('movers')} icon={BarChart3}>
            <DivergingBar labels={topMovers.map((i) => i.name)} values={topMovers.map((i) => toChartNumber(i.change))} height={Math.max(200, topMovers.length * 26)} />
          </Panel>
          <Panel title={t('detail')} icon={Table2} bodyClassName="p-0">
            {rows.length === 0 ? (
              <EmptyState icon={<Table2 size={28} />} title={t('empty')} description={undefined} />
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <SharedTable className="w-full text-sm">
                  <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                    <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                      <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.account')}</SharedTableHead>
                      <Th label={t('table.prior')} onClick={() => setSort('prior')} active={sort === 'prior'} />
                      <Th label={t('table.current')} onClick={() => setSort('current')} active={sort === 'current'} />
                      <Th label={t('table.change')} onClick={() => setSort('change')} active={sort === 'change'} />
                      <Th label={t('table.changePct')} onClick={() => setSort('changePct')} active={sort === 'changePct'} />
                      <Th label={t('table.share')} onClick={() => setSort('contribution')} active={sort === 'contribution'} />
                    </SharedTableRow>
                  </SharedTableHeader>
                  <SharedTableBody>
                    {sorted.map((it) => (
                      <InteractiveTableRow key={it.id} onClick={() => onDrill(it.id, it.name)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                        <SharedTableCell className="max-w-56 truncate px-4 py-2 text-slate-700 dark:text-slate-300">{it.name}</SharedTableCell>
                        <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(it.prior)}</SharedTableCell>
                        <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(it.current)}</SharedTableCell>
                        <SharedTableCell className={cn('px-4 py-2 text-right tabular-nums', cmp(it.change, '0') >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(it.change)}</SharedTableCell>
                        <SharedTableCell className={cn('px-4 py-2 text-right tabular-nums', it.changePct === null ? 'text-slate-400 dark:text-slate-500' : it.changePct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{it.changePct === null ? '—' : pctN(it.changePct)}</SharedTableCell>
                        <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{pctN(it.contribution)}</SharedTableCell>
                      </InteractiveTableRow>
                    ))}
                  </SharedTableBody>
                </SharedTable>
              </div>
            )}
          </Panel>
        </div>
        <div className="space-y-5">
          <MoversPanel title={t('gainers')} icon={ArrowUp} accent="emerald" rows={gainers} empty={t('none')} />
          <MoversPanel title={t('decliners')} icon={ArrowDown} accent="red" rows={decliners} empty={t('none')} />
        </div>
      </div>
    </div>
  )
}

function Th({ label, onClick, active }: { label: string; onClick: () => void; active: boolean }) {
  return (
    <SharedTableHead className="px-4 py-2 text-right font-medium">
      <button type="button" onClick={onClick} className={cn('hover:text-slate-700 dark:hover:text-slate-300', active && 'text-teal-600 dark:text-teal-400')}>
        {label}
      </button>
    </SharedTableHead>
  )
}

function MoversPanel({ title, icon: Icon, accent, rows, empty }: { title: string; icon: typeof ArrowUp; accent: 'emerald' | 'red'; rows: ItemRow[]; empty: string }) {
  const fmtMoney = useAnalyticsMoney()
  return (
    <Panel title={title} icon={Icon} bodyClassName="p-0">
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-slate-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-300">{r.name}</span>
              <span className={cn('shrink-0 text-sm font-medium tabular-nums', accent === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(r.change)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
