'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import { useMemo, useState } from 'react'
import { BarChart3, PieChart, Network } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { cn, EmptyState } from '@openbooks/ui'
import type { HealthData, SegmentRow } from '../../../../../lib/analytics/health-data'
import { cmp, sum } from '@openbooks/engine/money'
import { decimalRatio } from '../../../../../lib/reports/decimals'
import { Panel, SegToggle } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { Donut, GroupedBar } from '../../_ui/charts'
import { useAnalyticsMoney, useRatioFormat, toChartNumber } from '../../_ui/format'

type Dim = 'department' | 'class' | 'location'

export function SegmentsTab({ data }: { data: HealthData }) {
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const fmtRatio = useRatioFormat()
  const t = useTranslations('analytics.financialHealth.segments')
  const [dim, setDim] = useState<Dim>('department')
  const rows = data.segments[dim]
  const pctN = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)

  const { totalRev, totalOp, best, hhi } = useMemo(() => {
    const totalRev = sum(rows.map((r) => r.revenue))
    const totalOp = sum(rows.map((r) => r.operatingIncome))
    // Only graded segments can lead: a segment with no revenue carries no
    // margin, so it never tops the margin ranking either.
    const graded = rows.filter(
      (r): r is SegmentRow & { operatingMarginPct: number } => cmp(r.revenue, '0') > 0 && r.operatingMarginPct !== null,
    )
    const best = [...graded].sort((a, b) => b.operatingMarginPct - a.operatingMarginPct)[0]
    const hhi = Math.round(rows.reduce((s, r) => s + (r.sharePct * 100) ** 2, 0))
    return { totalRev, totalOp, best, hhi }
  }, [rows])

  // Concentration bands come from the organization's own configuration; the
  // starting levels follow the 2010 US merger-guideline HHI bands.
  const bands = data.bands.hhi
  const hhiTone = hhi >= bands.critical ? 'high' : hhi >= bands.warning ? 'mid' : 'low'

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={BarChart3} accent="teal" label={t('kpi.revenue')} value={fmtMoney(totalRev, { compact: true })} sub={t('kpiSub.rows', { count: rows.length })} />
        <KpiCard icon={BarChart3} accent="violet" label={t('kpi.operatingIncome')} value={fmtMoney(totalOp, { compact: true })} sub={cmp(totalRev, '0') > 0 ? (fmtRatio(decimalRatio(totalOp, totalRev), 'pct') ?? '—') : '—'} />
        <KpiCard icon={PieChart} accent="amber" label={t('kpi.bestMargin')} value={best ? pctN(best.operatingMarginPct) : '—'} sub={best?.name ?? '—'} />
        <KpiCard
          icon={Network}
          accent={hhiTone === 'high' ? 'red' : hhiTone === 'mid' ? 'amber' : 'emerald'}
          label={t('kpi.concentration')}
          value={t('hhiValue', { value: hhi })}
          sub={t(`hhi.${hhiTone}`)}
          tone={hhiTone === 'low' ? 'positive' : hhiTone === 'mid' ? 'neutral' : 'negative'}
        />
      </div>

      <Panel
        title={t('title')}
        icon={BarChart3}
        actions={
          <SegToggle
            value={dim}
            onChange={setDim}
            options={[
              { value: 'department', label: t('dim.department') },
              { value: 'class', label: t('dim.class') },
              { value: 'location', label: t('dim.location') },
            ]}
          />
        }
      >
        {rows.length === 0 ? (
          <EmptyState icon={<BarChart3 size={28} />} title={t('empty')} description={undefined} />
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <SharedTable className="w-full text-sm">
              <SharedTableHeader>
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-3 py-2 text-left font-medium">{t('table.segment')}</SharedTableHead>
                  <SharedTableHead className="px-3 py-2 text-right font-medium">{t('table.revenue')}</SharedTableHead>
                  <SharedTableHead className="px-3 py-2 text-right font-medium">{t('table.share')}</SharedTableHead>
                  <SharedTableHead className="px-3 py-2 text-right font-medium">{t('table.grossMargin')}</SharedTableHead>
                  <SharedTableHead className="px-3 py-2 text-right font-medium">{t('table.opMargin')}</SharedTableHead>
                  <SharedTableHead className="px-3 py-2 text-right font-medium">{t('table.yoy')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {rows.map((r) => (
                  <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <SharedTableCell className="px-3 py-2">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: r.health === 'good' ? '#10b981' : r.health === 'warn' ? '#f59e0b' : r.health === 'bad' ? '#ef4444' : '#94a3b8' }} />
                      {r.name}
                    </SharedTableCell>
                    <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(r.revenue)}</SharedTableCell>
                    <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{pctN(r.sharePct)}</SharedTableCell>
                    <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.grossMarginPct === null ? '—' : pctN(r.grossMarginPct)}</SharedTableCell>
                    <SharedTableCell className={cn('px-3 py-2 text-right tabular-nums', r.operatingMarginPct === null || r.operatingMarginPct >= 0 ? 'text-slate-600 dark:text-slate-300' : 'text-red-600 dark:text-red-400')}>{r.operatingMarginPct === null ? '—' : pctN(r.operatingMarginPct)}</SharedTableCell>
                    <SharedTableCell className={cn('px-3 py-2 text-right tabular-nums', r.yoyPct === null ? 'text-slate-400 dark:text-slate-500' : r.yoyPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{r.yoyPct === null ? '—' : pctN(r.yoyPct)}</SharedTableCell>
                  </SharedTableRow>
                ))}
              </SharedTableBody>
            </SharedTable>
            <div className="space-y-5">
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{t('chart.revenueBy')}</p>
                <Donut data={rows.filter((r) => cmp(r.revenue, '0') > 0).map((r) => ({ name: r.name, value: toChartNumber(r.revenue) }))} height={200} />
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{t('chart.marginsBy')}</p>
                <GroupedBar
                  labels={rows.map((r) => r.name)}
                  height={200}
                  series={[
                    { name: t('chart.grossProfit'), data: rows.map((r) => toChartNumber(r.grossProfit)), color: '#0d9488' },
                    { name: t('chart.operatingIncome'), data: rows.map((r) => toChartNumber(r.operatingIncome)), color: '#f59e0b' },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}
