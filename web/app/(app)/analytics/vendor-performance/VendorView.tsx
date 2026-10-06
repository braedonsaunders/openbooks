'use client'

import { useAnalyticsTab, AnalyticsTabContent } from '../use-analytics-tab'
import { ANALYTICS_TABS } from '../../../../lib/analytics/dashboard-tabs'

import { RecordTabs } from '@/components/module-home/record-tabs'

import { TableHead as SharedTableHead, Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../reports/ReportTable"
import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { formatPercent01 } from '@/lib/format'
import { Truck, Coins, Trophy, Layers, PieChart as PieIcon, BarChart3, Table2, Clock, TimerReset, HandCoins, ClipboardList, Grid2x2, Star, Info, Download } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { cmp, div, mulDecimal } from '@openbooks/engine/src/money/money.ts'
import type { VendorData, VendorRow, SpendTier, Grade, Quadrant } from '../../../../lib/analytics/vendor-data'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { concentrationVerdict } from '../../../../lib/analytics/vendor-concentration'
import { Gauge, NEUTRAL_GAUGE_BANDS } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { DivergingBar, Donut, TrendChart, Chart } from '../_ui/charts'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { escapeTooltipHtml, useAnalyticsMoney, toChartNumber } from '../_ui/format'
import { InteractiveTableRow } from '@/components/interactive-table-row'

const TABS = ANALYTICS_TABS['vendor-performance']
type Tab = (typeof TABS)[number]

const TIER_STYLE: Record<SpendTier, string> = {
  strategic: 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  core: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  tactical: 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  tail: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
}
const GRADE_STYLE: Record<Grade, string> = {
  A: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  B: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  C: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  F: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
const QUADRANT_COLOR: Record<Quadrant, string> = {
  strategic: '#8b5cf6',
  commodity: '#ef4444',
  niche: '#0d9488',
  transactional: '#94a3b8',
  unrated: '#a8a29e',
}

/** Sortable table header cell (module scope: defining it inside a tab remounts
 *  every header — and drops button focus — on each render). */
function SortHeaderCell<K extends string>({
  label,
  k,
  sort,
  onSort,
}: {
  label: string
  k?: K
  sort: K
  onSort: (k: K) => void
}) {
  return (
    <SharedTableHead className="px-4 py-2 text-right font-medium">
      {k ? <button type="button" onClick={() => onSort(k)} className={cn('hover:text-slate-700 dark:hover:text-slate-300', sort === k && 'text-teal-600 dark:text-teal-400')}>{label}</button> : label}
    </SharedTableHead>
  )
}

export function VendorView({ data: initialData, canConfigure }: { data: VendorData; canConfigure?: boolean }) {
  const t = useTranslations('analytics.vendor')
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number | string) => fmtMoney(n, { compact: true })
  const read = useAnalyticsTab('vendor-performance', { data: initialData }, TABS)
  const { tab, setTab } = read
  const { data } = read.props
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const totals = data.totals
  const diversification = Math.max(0, Math.min(100, (1 - totals.hhi) * 100))
  // The gauge word shares its band with the HHI card below (one threshold
  // source, the org's own HHI levels) — the score stays a 0–100
  // diversification number, but the word can never contradict the card's
  // concentration verdict again.
  const verdict = concentrationVerdict(totals.hhiScaled, data.config.hhiWarning, data.config.hhiCritical)
  const openVendor = (r: VendorRow) => setDrill({ kind: 'party', id: r.id, name: r.name, sub: t('drill.billsSpend', { bills: r.bills, spend: money(r.spend) }) })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={diversification} label={t(verdict.gaugeKey)} size={132} thickness={12} showTicks={false} bands={NEUTRAL_GAUGE_BANDS} />
        </div>
        <KpiCard icon={Truck} accent="sky" label={t('kpi.activeVendors')} value={String(totals.vendors)} sub={t('sub.inPeriod')} />
        <KpiCard icon={Coins} accent="violet" label={t('kpi.totalSpend')} value={money(totals.spend)} sub={totals.yoyPct === null ? t('sub.inPeriod') : t('sub.yoy', { pct: formatPercent01(totals.yoyPct, locale, 1) })} tone={totals.yoyPct === null ? 'neutral' : totals.yoyPct <= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Clock} accent={totals.onTimePct === null ? 'slate' : totals.onTimePct >= data.config.onTimeGoodRate / 100 ? 'emerald' : 'amber'} label={t('kpi.onTimeRate')} value={totals.onTimePct === null ? t('labels.unrated') : formatPercent01(totals.onTimePct, locale, 1)} sub={t('sub.onTimeBills')} />
        <KpiCard icon={PieIcon} accent="emerald" label={t('kpi.top5Share')} value={formatPercent01(totals.top5SharePct, locale, 1)} sub={t('sub.top5Concentration')} />
      </div>

      <RecordTabs label={t('title')} tabs={TABS.map((key) => ({ key, label: t(`tabs.${key}`) }))} active={tab} onChange={setTab}>
      <AnalyticsTabContent loading={read.loading} error={read.error} retry={read.retry}>
      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'payment' ? <PaymentTab data={data} onDrill={openVendor} /> : null}
        {tab === 'scorecard' ? <ScorecardTab data={data} onDrill={openVendor} /> : null}
        {tab === 'matrix' ? <MatrixTab data={data} /> : null}
        {tab === 'vendors' ? <VendorsTab data={data} onDrill={openVendor} /> : null}
        {tab === 'configuration' ? <ConfigEditor dashboard="vendorPerformance" canEdit={canConfigure === true} /> : null}
      </div>
            </AnalyticsTabContent>
      </RecordTabs>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */
function OverviewTab({ data }: { data: VendorData }) {
  const t = useTranslations('analytics.vendor')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number | string) => fmtMoney(n, { compact: true })
  const totals = data.totals
  const top = data.rows.slice(0, 10)
  // Same band as the overview gauge above — one threshold source for both words.
  const verdict = concentrationVerdict(totals.hhiScaled, data.config.hhiWarning, data.config.hhiCritical)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Coins} accent="violet" label={t('kpi.totalSpend')} value={money(totals.spend)} sub={t('sub.billsCount', { count: totals.bills })} />
        <KpiCard icon={Trophy} accent="teal" label={t('kpi.topVendor')} value={top[0] ? money(top[0].spend) : '—'} sub={top[0]?.name ?? '—'} />
        <KpiCard icon={BarChart3} accent="sky" label={t('kpi.avgBill')} value={money(totals.avgBill)} sub={t('sub.perBill')} />
        <KpiCard icon={Layers} accent="amber" label={t('kpi.hhi')} value={totals.hhiScaled.toString()} sub={t(verdict.subKey)} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.topBySpend')} icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => toChartNumber(r.spend))} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title={t('panels.spendByTier')} icon={PieIcon}>
          <Donut data={data.tierBreakdown.filter((x) => toChartNumber(x.spend) > 0).map((x) => ({ name: t(`tier.${x.tier}`), value: toChartNumber(x.spend) }))} height={220} />
        </Panel>
      </div>
      <Panel title={t('panels.spendTrend12mo')} icon={BarChart3}>
        <TrendChart labels={data.monthly.map((m) => m.label)} area height={200} series={[{ name: t('chart.spend'), data: data.monthly.map((m) => toChartNumber(m.spend)), color: '#8b5cf6' }]} />
      </Panel>
      <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          <span className="font-semibold">{t('info.title')}</span> {t('info.body')}
        </span>
      </p>
    </div>
  )
}

/* --------------------------------------------------------- Payment Behavior */
function PaymentTab({ data, onDrill }: { data: VendorData; onDrill: (r: VendorRow) => void }) {
  const t = useTranslations('analytics.vendor')
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number | string) => fmtMoney(n, { compact: true })
  const [sort, setSort] = useState<'spend' | 'avgDaysToPay' | 'onTimePct' | 'lateSpend'>('lateSpend')
  const totals = data.totals
  const paid = data.rows.filter((r) => r.paidBills > 0)
  const sortValue = (r: VendorRow, k: typeof sort): number =>
    k === 'onTimePct' || k === 'avgDaysToPay' ? (r[k] ?? -1) : toChartNumber(r[k])
  const rows = [...paid].sort((a, b) => sortValue(b, sort) - sortValue(a, sort))
  const worst = [...paid].filter((r) => toChartNumber(r.lateSpend) > 0).sort((a, b) => toChartNumber(b.lateSpend) - toChartNumber(a.lateSpend)).slice(0, 10)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Clock} accent={totals.onTimePct === null ? 'slate' : totals.onTimePct >= data.config.onTimeGoodRate / 100 ? 'emerald' : 'red'} label={t('kpi.onTimeRate')} value={totals.onTimePct === null ? t('labels.unrated') : formatPercent01(totals.onTimePct, locale, 1)} sub={t('sub.onTimeBills')} tone={totals.onTimePct === null ? 'neutral' : totals.onTimePct >= data.config.onTimeGoodRate / 100 ? 'positive' : 'negative'} />
        <KpiCard icon={TimerReset} accent="sky" label={t('kpi.avgDaysToPay')} value={totals.avgDaysToPay === null ? '—' : t('days', { days: Math.round(totals.avgDaysToPay) })} sub={t('sub.fromBillToPayment')} />
        <KpiCard icon={HandCoins} accent="amber" label={t('kpi.latePaidSpend')} value={money(totals.lateSpend)} sub={t('sub.paidAfterDue')} tone="negative" />
        <KpiCard icon={ClipboardList} accent="violet" label={t('kpi.vendorsPaid')} value={String(paid.length)} sub={t('sub.withPaymentHistory')} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.paymentBehaviour')} icon={ClipboardList} bodyClassName="p-0">
            <div className="max-h-[30rem] overflow-y-auto">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.vendor')}</SharedTableHead>
                    <SortHeaderCell label={t('table.spend')} k="spend" sort={sort} onSort={setSort} />
                    <SortHeaderCell label={t('table.paid')} sort={sort} onSort={setSort} />
                    <SortHeaderCell label={t('table.avgDays')} k="avgDaysToPay" sort={sort} onSort={setSort} />
                    <SortHeaderCell label={t('table.onTime')} k="onTimePct" sort={sort} onSort={setSort} />
                    <SortHeaderCell label={t('table.lateSpend')} k="lateSpend" sort={sort} onSort={setSort} />
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {rows.map((r) => (
                    <InteractiveTableRow key={r.id} onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                      <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.spend)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.paidBills}</SharedTableCell>
                      <SharedTableCell className={cn('px-4 py-2 text-right tabular-nums', (r.avgDaysToPay ?? 0) > data.config.slowPayDays ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300')}>{r.avgDaysToPay === null ? '—' : t('days', { days: Math.round(r.avgDaysToPay) })}</SharedTableCell>
                      <SharedTableCell className={cn('px-4 py-2 text-right font-medium tabular-nums', r.onTimePct === null ? 'text-slate-600 dark:text-slate-300' : r.onTimePct >= data.config.onTimeGoodRate / 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{r.onTimePct === null ? t('labels.unrated') : formatPercent01(r.onTimePct, locale, 1)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{toChartNumber(r.lateSpend) > 0 ? money(r.lateSpend) : '—'}</SharedTableCell>
                    </InteractiveTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
          </Panel>
        </div>
        <Panel title={t('panels.mostLatePaid')} icon={HandCoins}>
          {worst.length ? <DivergingBar labels={worst.map((r) => r.name)} values={worst.map((r) => toChartNumber(r.lateSpend))} height={Math.max(200, worst.length * 26)} /> : <p className="py-8 text-center text-xs text-slate-400">{t('empty.noLatePaid')}</p>}
          {totals.undatedBills > 0 ? <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">{t('payment.undatedNote', { count: totals.undatedBills })}</p> : null}
        </Panel>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Scorecard */
function ScorecardTab({ data, onDrill }: { data: VendorData; onDrill: (r: VendorRow) => void }) {
  const t = useTranslations('analytics.vendor')
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number | string) => fmtMoney(n, { compact: true })
  const rows = [...data.rows].sort((a, b) => b.score - a.score)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {data.gradeBreakdown.map((g) => (
          <div key={g.grade} className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <span className={cn('inline-grid h-9 w-9 place-items-center rounded-lg text-lg font-bold', GRADE_STYLE[g.grade])}>{g.grade}</span>
            <p className="mt-1.5 text-lg font-bold text-slate-900 tabular-nums dark:text-slate-100">{g.count}</p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">{money(g.spend)}</p>
          </div>
        ))}
      </div>
      <Panel title={t('panels.scorecard')} icon={Star} hint={t('panels.scorecardHint')} bodyClassName="p-0">
        <div className="max-h-[32rem] overflow-y-auto">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.vendor')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.spend')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.tier')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.bills')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.yoy')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.onTime')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.score')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.grade')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {rows.map((r) => (
                <InteractiveTableRow key={r.id} onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                  <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.spend)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{t(`tier.${r.tier}`)}</span></SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.bills}</SharedTableCell>
                  <SharedTableCell className={cn('px-4 py-2 text-right tabular-nums', (r.yoyPct ?? 0) <= 0 ? 'text-slate-500 dark:text-slate-400' : 'text-amber-600 dark:text-amber-400')}>{r.yoyPct === null ? '—' : formatPercent01(r.yoyPct, locale, 1)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.onTimePct === null ? t('labels.unrated') : formatPercent01(r.onTimePct, locale, 1)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-right font-bold tabular-nums text-slate-800 dark:text-slate-200">{Math.round(r.score)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded px-2 py-0.5 text-xs font-bold', GRADE_STYLE[r.grade])}>{r.grade}</span></SharedTableCell>
                </InteractiveTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </div>
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------- Leverage Matrix */
function MatrixTab({ data }: { data: VendorData }) {
  const t = useTranslations('analytics.vendor')
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number | string) => fmtMoney(n, { compact: true })
  const option = useMemo(() => matrixOption(data.rows, (n) => fmtMoney(n, { compact: true }), t, data.config.highPerformanceScore, locale), [data, fmtMoney, locale, t])
  const unratedNoPayments = data.rows.filter((r) => r.unratedReason === 'no-payments').length
  const unratedUndated = data.rows.filter((r) => r.unratedReason === 'undated').length
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.quadrantBreakdown.map((q) => (
          <div key={q.quadrant} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: QUADRANT_COLOR[q.quadrant] }} />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t(`quadrant.${q.quadrant}.label`)}</span>
            </div>
            <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums dark:text-slate-100">{q.count}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{money(q.spend)} · {t(`quadrant.${q.quadrant}.desc`)}</p>
          </div>
        ))}
      </div>
      <Panel title={t('panels.leverageMatrix')} icon={Grid2x2} hint={t('panels.leverageHint')}>
        <Chart option={option} height={420} />
        {unratedNoPayments > 0 ? <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">{t('matrix.unratedNoPaymentsNote', { count: unratedNoPayments })}</p> : null}
        {unratedUndated > 0 ? <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">{t('matrix.unratedUndatedNote', { count: unratedUndated })}</p> : null}
      </Panel>
    </div>
  )
}

/** One quadrant-matrix datum, as built below: { name, value: [logSpend, performance, spend] }. */
type MatrixPoint = { data: { name: string; value: [number, number, number] } }

function matrixOption(rows: VendorRow[], money: (value: number) => string, t: ReturnType<typeof useTranslations>, highPerformance: number, locale: string): Record<string, unknown> {
  const rated = rows.filter((r) => r.performance !== null)
  const maxSpend = Math.max(1, ...rated.map((r) => toChartNumber(r.spend)))
  const byQuad = (q: Quadrant) =>
    rated.filter((r) => r.quadrant === q).map((r) => ({
      value: [Math.log10(Math.max(toChartNumber(r.spend), 1)), r.performance ?? 0, toChartNumber(r.spend)],
      name: r.name,
      symbolSize: 8 + 34 * Math.sqrt(toChartNumber(r.spend) / maxSpend),
      itemStyle: { color: QUADRANT_COLOR[q], opacity: 0.75 },
    }))
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 28, containLabel: true },
    tooltip: { backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 }, formatter: (p: MatrixPoint) => `${escapeTooltipHtml(p.data.name)}<br/>${t('chart.tooltipSpend', { amount: money(p.data.value[2]) })}<br/>${t('chart.tooltipOnTime', { pct: formatPercent01(p.data.value[1] / 100, locale, 0) })}` },
    xAxis: { type: 'value', name: t('chart.xAxis'), nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } }, axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (v: number) => money(Math.pow(10, v)) } },
    yAxis: { type: 'value', name: t('chart.yAxis'), min: 0, max: 100, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } }, axisLabel: { color: '#94a3b8', fontSize: 9 } },
    series: [
      { type: 'scatter', data: byQuad('strategic'), name: t('quadrant.strategic.label') },
      { type: 'scatter', data: byQuad('commodity'), name: t('quadrant.commodity.label') },
      { type: 'scatter', data: byQuad('niche'), name: t('quadrant.niche.label') },
      { type: 'scatter', data: byQuad('transactional'), name: t('quadrant.transactional.label') },
      { type: 'line', markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'dashed' }, data: [{ yAxis: highPerformance }] }, data: [] },
    ],
  }
}

/* ------------------------------------------------------------ Vendors table */
function VendorsTab({ data, onDrill }: { data: VendorData; onDrill: (r: VendorRow) => void }) {
  const t = useTranslations('analytics.vendor')
  const locale = useLocale()
  const today = useBusinessToday()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number | string) => fmtMoney(n, { compact: true })
  const [sort, setSort] = useState<keyof Pick<VendorRow, 'spend' | 'bills' | 'avgBill' | 'recencyDays' | 'score'>>('spend')
  // CSV shares derive from the exact spend strings, never the float
  // quotient: binary multiplication on it prints tails like 14.4999999.
  // The on-time figure is stored as a float, so it rounds to basis points.
  const csvShare = (spend: string): string =>
    cmp(data.totals.spend, '0') > 0 ? mulDecimal(div(spend, data.totals.spend), '100') : '0'
  const csvOnTime = (v: number | null): string =>
    v === null ? '' : String(Math.round(v * 100 * 10000) / 10000)
  const rows = [...data.rows].sort((a, b) => {
    const num = (v: string | number | null | undefined): number =>
      v === null || v === undefined ? -1 : typeof v === 'number' ? v : toChartNumber(v)
    const av = num(a[sort])
    const bv = num(b[sort])
    return sort === 'recencyDays' ? av - bv : bv - av
  })
  return (
    <Panel
      title={t('panels.allVendors', { count: data.rows.length })}
      icon={Table2}
      bodyClassName="p-0"
      actions={
        <button
          type="button"
          onClick={() => exportCsv('vendors', [t('table.vendor'), t('table.spend'), t('csv.sharePct'), t('table.bills'), t('kpi.avgBill'), t('csv.onTimePct'), t('table.score'), t('table.tier')], rows.map((r) => [r.name, r.spend, csvShare(r.spend), r.bills, r.avgBill, csvOnTime(r.onTimePct), Math.round(r.score), t(`tier.${r.tier}`)]), today)}
          className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <Download size={11} /> {t('csv.export')}
        </button>
      }
    >
      <div className="max-h-[32rem] overflow-y-auto">
        <SharedTable className="w-full text-sm">
          <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
            <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.vendor')}</SharedTableHead>
              <SortHeaderCell label={t('table.spend')} k="spend" sort={sort} onSort={setSort} />
              <SortHeaderCell label={t('table.share')} sort={sort} onSort={setSort} />
              <SortHeaderCell label={t('table.bills')} k="bills" sort={sort} onSort={setSort} />
              <SortHeaderCell label={t('kpi.avgBill')} k="avgBill" sort={sort} onSort={setSort} />
              <SortHeaderCell label={t('table.onTime')} sort={sort} onSort={setSort} />
              <SortHeaderCell label={t('table.score')} k="score" sort={sort} onSort={setSort} />
              <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.tier')}</SharedTableHead>
            </SharedTableRow>
          </SharedTableHeader>
          <SharedTableBody>
            {rows.map((r) => (
              <InteractiveTableRow key={r.id} onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.spend)}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{formatPercent01(r.sharePct, locale, 1)}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.bills}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(r.avgBill)}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.onTimePct === null ? t('labels.unrated') : formatPercent01(r.onTimePct, locale, 1)}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-700 dark:text-slate-300">{Math.round(r.score)}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{t(`tier.${r.tier}`)}</span></SharedTableCell>
              </InteractiveTableRow>
            ))}
          </SharedTableBody>
        </SharedTable>
      </div>
    </Panel>
  )
}
