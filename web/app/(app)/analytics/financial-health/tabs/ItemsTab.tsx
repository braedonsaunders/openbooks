'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import { useMemo } from 'react'
import { ArrowUpRight, ArrowDownRight, ListTree } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { cmp } from '@openbooks/engine/money'
import { InteractiveTableRow } from '@/components/interactive-table-row'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { DivergingBar } from '../../_ui/charts'
import { useAnalyticsMoney, toChartNumber } from '../../_ui/format'

export function ItemsTab({ data, onDrill }: { data: HealthData; onDrill: (id: string, name: string) => void }) {
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const t = useTranslations('analytics.financialHealth.items')
  const pctN = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)

  const topMovers = useMemo(() => {
    const all = [...data.items.gainers, ...data.items.decliners]
    return all.sort((a, b) => Math.abs(toChartNumber(b.change)) - Math.abs(toChartNumber(a.change))).slice(0, 10)
  }, [data.items])
  const topGainer = data.items.gainers[0]
  const topDecliner = data.items.decliners[0]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={ArrowUpRight} accent="emerald" label={t('kpi.topGainer')} value={topGainer ? fmtMoney(topGainer.change) : '—'} sub={topGainer?.name ?? '—'} tone="positive" />
        <KpiCard icon={ArrowDownRight} accent="red" label={t('kpi.topDecliner')} value={topDecliner ? fmtMoney(topDecliner.change) : '—'} sub={topDecliner?.name ?? '—'} tone="negative" />
        <div className="col-span-2">
          <Panel title={t('movers')} icon={ListTree}>
            <DivergingBar labels={topMovers.map((i) => i.name)} values={topMovers.map((i) => toChartNumber(i.change))} height={Math.max(200, topMovers.length * 26)} />
          </Panel>
        </div>
      </div>

      <Panel title={t('detail')} icon={ListTree}>
        {data.items.rows.length === 0 ? (
          <EmptyState icon={<ListTree size={28} />} title={t('empty')} description={undefined} />
        ) : (
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.account')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.current')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.change')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.changePct')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.share')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {data.items.rows.map((it) => (
                <InteractiveTableRow key={it.id} onClick={() => onDrill(it.id, it.name)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                  <SharedTableCell className="max-w-56 truncate px-4 py-2 text-slate-700 dark:text-slate-300">{it.name}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(it.current, { compact: true })}</SharedTableCell>
                  <SharedTableCell className={cn('px-4 py-2 text-right font-medium tabular-nums', cmp(it.change, '0') >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{fmtMoney(it.change, { compact: true })}</SharedTableCell>
                  <SharedTableCell className={cn('px-4 py-2 text-right tabular-nums', it.changePct === null ? 'text-slate-400 dark:text-slate-500' : it.changePct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{it.changePct === null ? '—' : pctN(it.changePct)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">{pctN(it.contribution)}</SharedTableCell>
                </InteractiveTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        )}
      </Panel>
    </div>
  )
}
