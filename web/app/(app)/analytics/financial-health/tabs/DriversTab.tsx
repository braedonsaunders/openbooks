'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import { useMemo } from 'react'
import { TrendingUp, TrendingDown, ArrowLeftRight } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { abs, cmp } from '@openbooks/engine/money'
import { InteractiveTableRow } from '@/components/interactive-table-row'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { DivergingBar } from '../../_ui/charts'
import { useAnalyticsMoney, toChartNumber } from '../../_ui/format'

export function DriversTab({ data, onDrill }: { data: HealthData; onDrill: (id: string, name: string) => void }) {
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const t = useTranslations('analytics.financialHealth.drivers')
  const pctN = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)

  const topRev = useMemo(() => data.drivers.revenue.slice(0, 8), [data.drivers.revenue])
  const topCost = useMemo(() => data.drivers.cost.slice(0, 8), [data.drivers.cost])
  const top = useMemo(() => {
    const all = [...data.drivers.revenue, ...data.drivers.cost]
    // Rank by exact money magnitude — never through the chart projection.
    return all.sort((a, b) => cmp(abs(b.change), abs(a.change))).slice(0, 10)
  }, [data.drivers])
  const best = data.drivers.revenue[0]
  const worst = data.drivers.cost[0]
  // The server ranks each side by absolute movement, so the top row can be
  // a decline (revenue) or a saving (cost). The verdict follows sign times
  // favourability: revenue up is good, cost up is bad, flat is neutral.
  const bestTone = !best || cmp(best.change, '0') === 0 ? 'neutral' : cmp(best.change, '0') > 0 ? 'positive' : 'negative'
  const worstTone = !worst || cmp(worst.change, '0') === 0 ? 'neutral' : cmp(worst.change, '0') > 0 ? 'negative' : 'positive'

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={TrendingUp} accent="emerald" label={t('kpi.topRevenue')} value={best ? fmtMoney(best.change) : '—'} sub={best ? `${best.name} · ${t('kpiSub.vsPrior')}` : '—'} tone={bestTone} />
        <KpiCard icon={TrendingDown} accent="red" label={t('kpi.topCost')} value={worst ? fmtMoney(worst.change) : '—'} sub={worst ? `${worst.name} · ${t('kpiSub.vsPrior')}` : '—'} tone={worstTone} />
        <div className="col-span-2">
          <Panel title={t('movers')} icon={ArrowLeftRight}>
            <DivergingBar labels={top.map((d) => d.name)} values={top.map((d) => toChartNumber(d.change))} height={Math.max(180, top.length * 26)} />
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DriverTable title={t('revenueTitle')} icon={TrendingUp} rows={topRev} empty={t('emptyRevenue')} fmtMoney={fmtMoney} pctN={pctN} t={t} onDrill={onDrill} />
        <DriverTable title={t('costTitle')} icon={TrendingDown} rows={topCost} empty={t('emptyCost')} fmtMoney={fmtMoney} pctN={pctN} t={t} onDrill={onDrill} />
      </div>
    </div>
  )
}

function DriverTable({ title, icon: Icon, rows, empty, fmtMoney, pctN, t, onDrill }: {
  title: string
  icon: typeof TrendingUp
  rows: HealthData['drivers']['revenue']
  empty: string
  fmtMoney: ReturnType<typeof useAnalyticsMoney>
  pctN: (n: number) => string
  t: (key: string) => string
  onDrill: (id: string, name: string) => void
}) {
  return (
    <Panel title={title} icon={Icon}>
      {rows.length === 0 ? (
        <EmptyState icon={<Icon size={28} />} title={empty} description={undefined} />
      ) : (
        <SharedTable className="w-full text-sm">
          <SharedTableHeader>
            <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SharedTableHead className="py-1.5 text-left font-medium">{t('table.driver')}</SharedTableHead>
              <SharedTableHead className="py-1.5 text-right font-medium">{t('table.current')}</SharedTableHead>
              <SharedTableHead className="py-1.5 text-right font-medium">{t('table.change')}</SharedTableHead>
              <SharedTableHead className="py-1.5 text-right font-medium">{t('table.changePct')}</SharedTableHead>
              <SharedTableHead className="py-1.5 text-right font-medium">{t('table.share')}</SharedTableHead>
            </SharedTableRow>
          </SharedTableHeader>
          <SharedTableBody>
            {rows.map((d) => (
              <InteractiveTableRow key={d.id} onClick={() => onDrill(d.id, d.name)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                <SharedTableCell className="max-w-44 truncate py-1.5 pr-2 text-slate-700 dark:text-slate-300">{d.name}</SharedTableCell>
                <SharedTableCell className="py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(d.current, { compact: true })}</SharedTableCell>
                <SharedTableCell className={cn('py-1.5 text-right font-medium tabular-nums', cmp(d.change, '0') >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(d.change, { compact: true })}</SharedTableCell>
                <SharedTableCell className="py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{d.changePct === null ? '—' : pctN(d.changePct)}</SharedTableCell>
                <SharedTableCell className="py-1.5 text-right tabular-nums text-slate-400 dark:text-slate-500">{pctN(d.contribution)}</SharedTableCell>
              </InteractiveTableRow>
            ))}
          </SharedTableBody>
        </SharedTable>
      )}
    </Panel>
  )
}
