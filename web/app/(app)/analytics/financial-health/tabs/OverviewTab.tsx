'use client'

import { useState } from 'react'
import { LineChart, TrendingUp, CircleAlert, Lightbulb } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import type { HealthData, Insight } from '../../../../../lib/analytics/health-data'
import { Panel, SegToggle } from '../../_ui/Panel'
import { GroupedBar, TrendChart } from '../../_ui/charts'
import { useAnalyticsMoney, useRatioFormat, toChartNumber } from '../../_ui/format'

export function OverviewTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const fmtRatio = useRatioFormat()
  const t = useTranslations('analytics.financialHealth.overview')
  const [revView, setRevView] = useState<'money' | 'margin'>('money')
  const m = data.monthly
  const sparkMoney = (key: 'revenue' | 'operatingIncome') => m.map((p) => toChartNumber(p[key]))
  const sparkPct = (key: 'grossMarginPct' | 'operatingMarginPct') => m.map((p) => p[key])
  const grossMargin = Object.values(data.ratios).flat().find((r) => r.id === 'gross_margin')

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel
          title={t('trendRevenue')}
          icon={LineChart}
          actions={
            <SegToggle
              value={revView}
              onChange={setRevView}
              options={[
                { value: 'money', label: t('revTab') },
                { value: 'margin', label: t('marginTab') },
              ]}
            />
          }
        >
          {revView === 'money' ? (
            <GroupedBar
              labels={m.map((p) => p.label)}
              height={220}
              series={[
                { name: t('series.revenue'), data: m.map((p) => toChartNumber(p.revenue)), color: '#0d9488' },
                { name: t('series.grossProfit'), data: m.map((p) => toChartNumber(p.grossProfit)), color: '#6366f1' },
                { name: t('series.operatingIncome'), data: m.map((p) => toChartNumber(p.operatingIncome)), color: '#f59e0b' },
              ]}
            />
          ) : (
            <TrendChart
              labels={m.map((p) => p.label)}
              pctAxis
              height={220}
              series={[
                { name: t('series.grossMargin'), data: m.map((p) => p.grossMarginPct), color: '#0d9488', pct: true },
                { name: t('series.operatingMargin'), data: m.map((p) => p.operatingMarginPct), color: '#f59e0b', pct: true },
              ]}
            />
          )}
        </Panel>
        <div className="grid grid-cols-2 gap-3">
          <SparkCard label={t('trendRevenue')} points={sparkMoney('revenue')} last={fmtMoney(data.figures.revenue, { compact: true })} />
          <SparkCard label={t('trendMargin')} points={sparkPct('grossMarginPct')} pct last={fmtRatio(grossMargin?.value ?? null, 'pct') ?? '—'} />
          <SparkCard label={t('trendOpinc')} points={sparkMoney('operatingIncome')} last={fmtMoney(data.figures.operatingIncome, { compact: true })} />
          <SparkCard label={t('trendOpMargin')} points={sparkPct('operatingMarginPct')} pct last={fmtRatio(Object.values(data.ratios).flat().find((r) => r.id === 'operating_margin')?.value ?? null, 'pct') ?? '—'} />
        </div>
      </div>

      <Panel title={t('perfTrend')} icon={TrendingUp}>
        <SharedTable className="w-full text-sm">
          <SharedTableHeader>
            <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.item')}</SharedTableHead>
              <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.current')}</SharedTableHead>
              <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.prior')}</SharedTableHead>
              <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.change')}</SharedTableHead>
              <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.changePct')}</SharedTableHead>
            </SharedTableRow>
          </SharedTableHeader>
          <SharedTableBody>
            {data.pnlSummary.map((l) => {
              // Favorability, not sign: a COGS/OpEx/Other-Expense increase is bad.
              const isCost = l.key === 'cogs' || l.key === 'opex' || l.key === 'otherExpense'
              const rising = !l.change.startsWith('-') && !/^0(\.0+)?$/.test(l.change)
              const falling = l.change.startsWith('-')
              const good = isCost ? !rising : !falling
              const changeCls = good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
              return (
              <SharedTableRow key={l.key} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <SharedTableCell className={cn('px-4 py-2', l.strong ? 'font-semibold text-slate-800 dark:text-slate-200' : 'text-slate-600 dark:text-slate-300')}>{l.label}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{fmtMoney(l.current, { compact: true })}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(l.prior, { compact: true })}</SharedTableCell>
                <SharedTableCell className={cn('px-4 py-2 text-right font-medium tabular-nums', changeCls)}>{fmtMoney(l.change, { compact: true })}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">
                  {fmtRatio(l.changePct, 'pct') ?? '—'}
                </SharedTableCell>
              </SharedTableRow>
              )
            })}
          </SharedTableBody>
        </SharedTable>
      </Panel>

      <InsightList insights={data.insights} t={t} />
    </div>
  )
}

function SparkCard({ label, points, last, pct }: { label: string; points: (number | null)[]; last: string; pct?: boolean }) {
  const nums = points.filter((p): p is number => p !== null)
  const up = nums.length > 1 && nums[nums.length - 1]! >= nums[0]!
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={cn('mt-0.5 text-lg font-bold tabular-nums', up ? 'text-slate-800 dark:text-slate-100' : 'text-red-600 dark:text-red-400')}>{last}</p>
      <TrendChart labels={points.map((_, i) => String(i))} height={52} hideAxes series={[{ name: label, data: points, color: up ? '#0d9488' : '#ef4444', pct: pct ?? false }]} />
    </div>
  )
}

function InsightList({ insights, t }: { insights: Insight[]; t: (key: string) => string }) {
  const groups: Array<{ key: 'issues' | 'recs' | 'anomalies'; items: Insight[] }> = [
    { key: 'issues', items: insights.filter((i) => i.severity === 'critical' || i.severity === 'warn') },
    { key: 'recs', items: insights.filter((i) => i.severity === 'info') },
    { key: 'anomalies', items: insights.filter((i) => i.severity === 'anomaly') },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      {groups.map((g) => (
        <Panel key={g.key} title={t(`groups.${g.key}`)} icon={g.key === 'recs' ? Lightbulb : CircleAlert}>
          {g.items.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">{t('empty')}</p>
          ) : (
            <ul className="space-y-2">
              {g.items.map((ins, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                  <SeverityBadge severity={ins.severity} t={t} />
                  <span className="text-slate-600 dark:text-slate-300">{ins.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  )
}

function SeverityBadge({ severity, t }: { severity: Insight['severity']; t: (key: string) => string }) {
  const cls =
    severity === 'critical'
      ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
      : severity === 'warn'
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
        : severity === 'anomaly'
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
          : 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300'
  return <span className={cn('mt-0.5 shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold', cls)}>{t(`severity.${severity}`)}</span>
}
