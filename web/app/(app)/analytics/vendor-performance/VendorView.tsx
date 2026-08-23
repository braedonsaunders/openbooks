'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Truck, DollarSign, Trophy, Layers, PieChart as PieIcon, BarChart3, Table2, Clock, TimerReset, HandCoins, ClipboardList, Grid2x2, Star, Info, Download } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { VendorData, VendorRow, SpendTier, Grade, Quadrant } from '../../../../lib/analytics/vendor-data'
import { Gauge } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { DivergingBar, Donut, TrendChart, Chart } from '../_ui/charts'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { useAnalyticsMoney, fmtPct } from '../_ui/format'

const TABS = ['overview', 'payment', 'scorecard', 'matrix', 'vendors'] as const
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
}

export function VendorView({ data }: { data: VendorData }) {
  const t = useTranslations('analytics.vendor')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const totals = data.totals
  const diversification = Math.max(0, Math.min(100, (1 - totals.hhi) * 100))
  const openVendor = (r: VendorRow) => setDrill({ kind: 'party', id: r.id, name: r.name, sub: t('drill.billsSpend', { bills: r.bills, spend: money(r.spend) }) })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={diversification} label={t(diversification >= 85 ? 'gauge.diversified' : diversification >= 70 ? 'gauge.balanced' : 'gauge.concentrated')} size={132} thickness={12} showTicks={false} />
        </div>
        <KpiCard icon={Truck} accent="sky" label={t('kpi.activeVendors')} value={String(totals.vendors)} sub={t('sub.inPeriod')} />
        <KpiCard icon={DollarSign} accent="violet" label={t('kpi.totalSpend')} value={money(totals.spend)} sub={totals.yoyPct === null ? t('sub.inPeriod') : t('sub.yoy', { pct: fmtPct(totals.yoyPct) })} tone={(totals.yoyPct ?? 0) <= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Clock} accent={(totals.onTimePct ?? 0) >= 0.6 ? 'emerald' : 'amber'} label={t('kpi.onTimeRate')} value={totals.onTimePct === null ? '—' : fmtPct(totals.onTimePct)} sub={t('sub.onTimeBills')} />
        <KpiCard icon={PieIcon} accent="emerald" label={t('kpi.top5Share')} value={fmtPct(totals.top5SharePct)} sub={t('sub.top5Concentration')} />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {t(`tabs.${k}`)}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'payment' ? <PaymentTab data={data} onDrill={openVendor} /> : null}
        {tab === 'scorecard' ? <ScorecardTab data={data} onDrill={openVendor} /> : null}
        {tab === 'matrix' ? <MatrixTab data={data} /> : null}
        {tab === 'vendors' ? <VendorsTab data={data} onDrill={openVendor} /> : null}
      </div>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */
function OverviewTab({ data }: { data: VendorData }) {
  const t = useTranslations('analytics.vendor')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const totals = data.totals
  const top = data.rows.slice(0, 10)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={DollarSign} accent="violet" label={t('kpi.totalSpend')} value={money(totals.spend)} sub={t('sub.billsCount', { count: totals.bills })} />
        <KpiCard icon={Trophy} accent="teal" label={t('kpi.topVendor')} value={top[0] ? money(top[0].spend) : '—'} sub={top[0]?.name ?? '—'} />
        <KpiCard icon={BarChart3} accent="sky" label={t('kpi.avgBill')} value={money(totals.avgBill)} sub={t('sub.perBill')} />
        <KpiCard icon={Layers} accent="amber" label={t('kpi.hhi')} value={totals.hhiScaled.toString()} sub={totals.hhiScaled > 2500 ? t('sub.highlyConcentrated') : totals.hhiScaled > 1500 ? t('sub.moderate') : t('sub.diversified')} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.topBySpend')} icon={BarChart3}>
            <DivergingBar labels={top.map((r) => r.name)} values={top.map((r) => r.spend)} height={Math.max(220, top.length * 28)} />
          </Panel>
        </div>
        <Panel title={t('panels.spendByTier')} icon={PieIcon}>
          <Donut data={data.tierBreakdown.filter((x) => x.spend > 0).map((x) => ({ name: t(`tier.${x.tier}`), value: x.spend }))} height={220} />
        </Panel>
      </div>
      <Panel title={t('panels.spendTrend12mo')} icon={BarChart3}>
        <TrendChart labels={data.monthly.map((m) => m.label)} area height={200} series={[{ name: t('chart.spend'), data: data.monthly.map((m) => m.spend), color: '#8b5cf6' }]} />
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
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [sort, setSort] = useState<'spend' | 'avgDaysToPay' | 'onTimePct' | 'lateSpend'>('lateSpend')
  const totals = data.totals
  const paid = data.rows.filter((r) => r.paidBills > 0)
  const rows = [...paid].sort((a, b) => {
    if (sort === 'onTimePct') return (b.onTimePct ?? -1) - (a.onTimePct ?? -1)
    return (b[sort] as number) - (a[sort] as number)
  })
  const worst = [...paid].filter((r) => r.lateSpend > 0).sort((a, b) => b.lateSpend - a.lateSpend).slice(0, 10)

  const Th = ({ label, k }: { label: string; k?: typeof sort }) => (
    <th className="px-4 py-2 text-right font-medium">
      {k ? <button type="button" onClick={() => setSort(k)} className={cn('hover:text-slate-700 dark:hover:text-slate-300', sort === k && 'text-teal-600 dark:text-teal-400')}>{label}</button> : label}
    </th>
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Clock} accent={(totals.onTimePct ?? 0) >= 0.6 ? 'emerald' : 'red'} label={t('kpi.onTimeRate')} value={totals.onTimePct === null ? '—' : fmtPct(totals.onTimePct)} sub={t('sub.onTimeBills')} tone={(totals.onTimePct ?? 0) >= 0.6 ? 'positive' : 'negative'} />
        <KpiCard icon={TimerReset} accent="sky" label={t('kpi.avgDaysToPay')} value={totals.avgDaysToPay === null ? '—' : t('days', { days: Math.round(totals.avgDaysToPay) })} sub={t('sub.fromBillToPayment')} />
        <KpiCard icon={HandCoins} accent="amber" label={t('kpi.latePaidSpend')} value={money(totals.lateSpend)} sub={t('sub.paidAfterDue')} tone="negative" />
        <KpiCard icon={ClipboardList} accent="violet" label={t('kpi.vendorsPaid')} value={String(paid.length)} sub={t('sub.withPaymentHistory')} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('panels.paymentBehaviour')} icon={ClipboardList} bodyClassName="p-0">
            <div className="max-h-[30rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.vendor')}</th>
                    <Th label={t('table.spend')} k="spend" />
                    <Th label={t('table.paid')} />
                    <Th label={t('table.avgDays')} k="avgDaysToPay" />
                    <Th label={t('table.onTime')} k="onTimePct" />
                    <Th label={t('table.lateSpend')} k="lateSpend" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.spend)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.paidBills}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', (r.avgDaysToPay ?? 0) > 45 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300')}>{r.avgDaysToPay === null ? '—' : t('days', { days: Math.round(r.avgDaysToPay) })}</td>
                      <td className={cn('px-4 py-2 text-right font-medium tabular-nums', (r.onTimePct ?? 0) >= 0.6 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{r.onTimePct === null ? '—' : fmtPct(r.onTimePct)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.lateSpend > 0 ? money(r.lateSpend) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        <Panel title={t('panels.mostLatePaid')} icon={HandCoins}>
          {worst.length ? <DivergingBar labels={worst.map((r) => r.name)} values={worst.map((r) => r.lateSpend)} height={Math.max(200, worst.length * 26)} /> : <p className="py-8 text-center text-xs text-slate-400">{t('empty.noLatePaid')}</p>}
        </Panel>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Scorecard */
function ScorecardTab({ data, onDrill }: { data: VendorData; onDrill: (r: VendorRow) => void }) {
  const t = useTranslations('analytics.vendor')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
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
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.vendor')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.spend')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.tier')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.bills')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.yoy')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.onTime')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.score')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.grade')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(r.spend)}</td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{t(`tier.${r.tier}`)}</span></td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.bills}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', (r.yoyPct ?? 0) <= 0 ? 'text-slate-500 dark:text-slate-400' : 'text-amber-600 dark:text-amber-400')}>{r.yoyPct === null ? '—' : fmtPct(r.yoyPct)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.onTimePct === null ? '—' : fmtPct(r.onTimePct)}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums text-slate-800 dark:text-slate-200">{Math.round(r.score)}</td>
                  <td className="px-4 py-2 text-center"><span className={cn('rounded px-2 py-0.5 text-xs font-bold', GRADE_STYLE[r.grade])}>{r.grade}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------- Leverage Matrix */
function MatrixTab({ data }: { data: VendorData }) {
  const t = useTranslations('analytics.vendor')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const option = useMemo(() => matrixOption(data.rows, money, t), [data, fmtMoney, t])
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
      </Panel>
    </div>
  )
}

function matrixOption(rows: VendorRow[], money: (value: number) => string, t: ReturnType<typeof useTranslations>): Record<string, unknown> {
  const maxSpend = Math.max(1, ...rows.map((r) => r.spend))
  const byQuad = (q: Quadrant) =>
    rows.filter((r) => r.quadrant === q).map((r) => ({
      value: [Math.log10(Math.max(r.spend, 1)), r.performance, r.spend],
      name: r.name,
      symbolSize: 8 + 34 * Math.sqrt(r.spend / maxSpend),
      itemStyle: { color: QUADRANT_COLOR[q], opacity: 0.75 },
    }))
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 28, containLabel: true },
    tooltip: { backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 }, formatter: (p: any) => `${p.data.name}<br/>${t('chart.tooltipSpend', { amount: money(p.data.value[2]) })}<br/>${t('chart.tooltipOnTime', { pct: p.data.value[1].toFixed(0) })}` },
    xAxis: { type: 'value', name: t('chart.xAxis'), nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } }, axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (v: number) => money(Math.pow(10, v)) } },
    yAxis: { type: 'value', name: t('chart.yAxis'), min: 0, max: 100, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } }, axisLabel: { color: '#94a3b8', fontSize: 9 } },
    series: [
      { type: 'scatter', data: byQuad('strategic'), name: t('quadrant.strategic.label') },
      { type: 'scatter', data: byQuad('commodity'), name: t('quadrant.commodity.label') },
      { type: 'scatter', data: byQuad('niche'), name: t('quadrant.niche.label') },
      { type: 'scatter', data: byQuad('transactional'), name: t('quadrant.transactional.label') },
      { type: 'line', markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'dashed' }, data: [{ yAxis: 75 }] }, data: [] },
    ],
  }
}

/* ------------------------------------------------------------ Vendors table */
function VendorsTab({ data, onDrill }: { data: VendorData; onDrill: (r: VendorRow) => void }) {
  const t = useTranslations('analytics.vendor')
  const today = useBusinessToday()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [sort, setSort] = useState<keyof Pick<VendorRow, 'spend' | 'bills' | 'avgBill' | 'recencyDays' | 'score'>>('spend')
  const rows = [...data.rows].sort((a, b) => {
    const av = a[sort] ?? -1
    const bv = b[sort] ?? -1
    return sort === 'recencyDays' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
  const Th = ({ label, k }: { label: string; k?: typeof sort }) => (
    <th className="px-4 py-2 text-right font-medium">
      {k ? <button type="button" onClick={() => setSort(k)} className={cn('hover:text-slate-700 dark:hover:text-slate-300', sort === k && 'text-teal-600 dark:text-teal-400')}>{label}</button> : label}
    </th>
  )
  return (
    <Panel
      title={t('panels.allVendors', { count: data.rows.length })}
      icon={Table2}
      bodyClassName="p-0"
      actions={
        <button
          type="button"
          onClick={() => exportCsv('vendors', [t('table.vendor'), t('table.spend'), t('csv.sharePct'), t('table.bills'), t('kpi.avgBill'), t('csv.onTimePct'), t('table.score'), t('table.tier')], rows.map((r) => [r.name, Math.round(r.spend), (r.sharePct * 100).toFixed(1), r.bills, Math.round(r.avgBill), r.onTimePct === null ? '' : (r.onTimePct * 100).toFixed(0), Math.round(r.score), t(`tier.${r.tier}`)]), today)}
          className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <Download size={11} /> CSV
        </button>
      }
    >
      <div className="max-h-[32rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">{t('table.vendor')}</th>
              <Th label={t('table.spend')} k="spend" />
              <Th label={t('table.share')} />
              <Th label={t('table.bills')} k="bills" />
              <Th label={t('kpi.avgBill')} k="avgBill" />
              <Th label={t('table.onTime')} />
              <Th label={t('table.score')} k="score" />
              <th className="px-4 py-2 text-center font-medium">{t('table.tier')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => onDrill(r)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(r.spend)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtPct(r.sharePct)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.bills}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(r.avgBill)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.onTimePct === null ? '—' : fmtPct(r.onTimePct)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-700 dark:text-slate-300">{Math.round(r.score)}</td>
                <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TIER_STYLE[r.tier])}>{t(`tier.${r.tier}`)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
