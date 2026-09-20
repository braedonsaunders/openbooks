'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useMemo, useState } from 'react'
import {
  University,
  Wallet,
  TriangleAlert,
  ArrowDown,
  ArrowUp,
  Flame,
  ShieldCheck,
  RefreshCw,
  ArrowLeftRight,
  Route,
  Waypoints,
  AreaChart,
  ArrowUpRight,
  ListOrdered,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { cmp as compareMoney, div as divideMoney, sum as sumMoney } from '@openbooks/engine/src/money/money.ts'
import type { CashflowData, SideSummary } from '../../../../lib/analytics/cashflow-data'
import { Panel } from '../_ui/Panel'
import { TrendChart, Chart, cashBridgeOption } from '../_ui/charts'
import { Vital } from '../_ui/Vital'
import { formatExactPercent, formatExactRatio, toChartNumber, useAnalyticsMoney } from '../_ui/format'

// Analysis only — the interactive surfaces this view used to carry moved to
// their operational homes at full fidelity: the weekly timeline + forecast
// categories to Banking → Cash, the AP pay-selection rule to the AP cockpit.
const TABS = ['overview', 'category'] as const
type Tab = (typeof TABS)[number]
// Bucket colours key off the cash-core bucket codes (Current, 1-30, …),
// which travel with the data and never localize.
const BUCKET_COLORS: Record<string, string> = { Current: '#10b981', '1-30': '#14b8a6', '31-60': '#0ea5e9', '61-90': '#f59e0b', '90+': '#ef4444' }

export function CashflowView({ data }: { data: CashflowData }) {
  const t = useTranslations('analytics.cashflow')
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: string | number) => fmtMoney(n, { compact: true })
  const [tab, setTab] = useState<Tab>('overview')
  const s = data.summary
  const lowestWeek = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(s.lowestWeek + 'T00:00:00Z'))

  return (
    <div className="space-y-5">
      {/* KPI row: Current Cash / Projected End / Lowest Point / Inflows / Outflows */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi icon={University} accent="slate" label={t('kpi.currentCash')} value={money(s.startingCash)} tone={compareMoney(s.startingCash, '0.0000') < 0 ? 'neg' : undefined} />
        <Kpi icon={Wallet} accent="sky" label={t('kpi.projectedEnd')} value={money(s.projectedEnd)} sub={t('kpi.netSub', { change: `${compareMoney(s.netChange, '0.0000') >= 0 ? '+' : ''}${money(s.netChange)}` })} tone={compareMoney(s.netChange, '0.0000') >= 0 ? 'pos' : 'neg'} />
        <Kpi icon={TriangleAlert} accent={compareMoney(s.lowestCash, '0.0000') < 0 ? 'red' : 'amber'} label={t('kpi.lowestPoint')} value={money(s.lowestCash)} sub={lowestWeek} tone={compareMoney(s.lowestCash, '0.0000') < 0 ? 'neg' : undefined} />
        <Kpi icon={ArrowDown} accent="emerald" label={t('kpi.inflows')} value={money(s.totalInflows)} tone="pos" />
        <Kpi icon={ArrowUp} accent="red" label={t('kpi.outflows')} value={money(s.totalOutflows)} tone="neg" />
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
        {tab === 'category' ? <CategoryTab data={data} /> : null}
      </div>

      <p className="flex items-center justify-center gap-1 text-center text-xs text-slate-400 dark:text-slate-500">
        {t('footer.pre')}
        <Link href={('/banking/cash')} className="inline-flex items-center gap-0.5 font-medium text-teal-600 hover:underline dark:text-teal-400">
          {t('footer.cashCockpit')} <ArrowUpRight size={12} />
        </Link>
        {t('footer.mid')}
        <Link href={('/ap')} className="inline-flex items-center gap-0.5 font-medium text-teal-600 hover:underline dark:text-teal-400">
          {t('footer.apCockpit')} <ArrowUpRight size={12} />
        </Link>
        {t('footer.post')}
      </p>
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */
function OverviewTab({ data }: { data: CashflowData }) {
  const t = useTranslations('analytics.cashflow')
  const fmtMoney = useAnalyticsMoney()
  const money = useCallback((n: string | number) => fmtMoney(n, { compact: true }), [fmtMoney])
  const tCharts = useTranslations('analytics.charts')
  const s = data.summary
  const bridgeLabels = useMemo(() => ({
    start: tCharts('bridge.start'),
    inflows: tCharts('bridge.inflows'),
    outflows: tCharts('bridge.outflows'),
    projectedEnd: tCharts('bridge.projectedEnd'),
  }), [tCharts])
  const bridgeOption = useMemo(() => cashBridgeOption(s.startingCash, s.totalInflows, s.totalOutflows, s.projectedEnd, money, bridgeLabels), [s, money, bridgeLabels])

  return (
    <div className="space-y-5">
      {/* Vitals hero */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Vital icon={Flame} ring="from-violet-500 to-fuchsia-500" label={t('vitals.burnRate')} value={money(s.burnRate)} hint={t('vitals.burnHint')} badge={t('vitals.burnBadge')} />
        <Vital icon={ShieldCheck} ring="from-sky-500 to-blue-500" label={t('vitals.arCoverage')} value={s.arCoverage === null ? '—' : `${formatExactRatio(s.arCoverage)}×`} hint={t('vitals.arHint')} />
        <Vital icon={RefreshCw} ring="from-teal-500 to-emerald-500" label={t('vitals.cashCycle')} value={`${s.dso ?? '—'} / ${s.dpo ?? '—'}`} hint={t('vitals.cashCycleHint')} split />
        <Vital icon={ArrowLeftRight} ring={compareMoney(s.netChange, '0.0000') >= 0 ? 'from-emerald-500 to-teal-500' : 'from-red-500 to-orange-500'} label={t('vitals.netFlow')} value={money(s.netChange)} hint={t('vitals.netFlowHint')} />
        <Vital icon={Route} ring="from-indigo-500 to-violet-500" label={t('vitals.runway')} value={s.runwayWeeks === null ? '∞' : `${formatExactRatio(s.runwayWeeks, 1)}w`} hint={s.runwayStatus === 'critical' ? t('vitals.runwayCritical') : s.runwayStatus === 'caution' ? t('vitals.runwayCaution') : t('vitals.runwayHealthy')} status={s.runwayStatus} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.bridge')} icon={Waypoints}>
          <Chart option={bridgeOption} height={260} />
        </Panel>
        <Panel title={t('panels.forecast')} icon={AreaChart}>
          <TrendChart labels={data.weeks.map((w) => w.label.split(' – ')[0]!)} area height={260} series={[{ name: t('series.endingCash'), data: data.weeks.map((w) => toChartNumber(w.endingCash)), color: '#0d9488' }]} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <AgingPanel title={t('panels.ar')} side={data.ar} accent="text-sky-600 dark:text-sky-400" />
        <AgingPanel title={t('panels.ap')} side={data.ap} accent="text-red-600 dark:text-red-400" />
      </div>
    </div>
  )
}

function AgingPanel({ title, side, accent }: { title: string; side: SideSummary; accent: string }) {
  const t = useTranslations('analytics.cashflow')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: string | number) => fmtMoney(n, { compact: true })
  const total = compareMoney(side.outstanding, '0.0000') > 0 ? side.outstanding : '1.0000'
  return (
    <Panel title={title} icon={ListOrdered} hint={t('panels.agingHint', { amount: money(side.outstanding), pct: formatExactPercent(side.pctCurrent) })}>
      <div className="space-y-2">
        {side.buckets.map((b) => (
          <div key={b.label}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: BUCKET_COLORS[b.label] }} />
                {b.label}
              </span>
              <span className={cn('tabular-nums', accent)}>{money(b.amount)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div className="h-full rounded-full" style={{ width: `${Math.max(0, toChartNumber(divideMoney(b.amount, total)) * 100)}%`, backgroundColor: BUCKET_COLORS[b.label] }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* --------------------------------------------------------- Category Analysis */
function CategoryTab({ data }: { data: CashflowData }) {
  const t = useTranslations('analytics.cashflow')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: string | number) => fmtMoney(n, { compact: true })
  const [side, setSide] = useState<'ar' | 'ap'>('ap')
  // Already grouped server-side — the page no longer ships every week's
  // transactions just so this tab can total them by counterparty.
  const entries = data.partyTotals[side]
  const total = sumMoney(entries.map((e) => e.amount))

  return (
    <div className="space-y-4">
      {data.categories.length ? (
        <Panel title={t('panels.forecastCategories')} icon={SlidersHorizontal} hint={t('panels.forecastCatHint')} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('catTable.category')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('catTable.method')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('catTable.logic')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('catTable.perWeek')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('catTable.horizonTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5">
                    <span className={cn('mr-2 inline-block h-2 w-2 rounded-full', c.direction === 'inflow' ? 'bg-emerald-500' : 'bg-red-500')} />
                    <span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                  </td>
                  <td className="px-4 py-2.5"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{c.method.replace(/_/g, ' ')}</span></td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">{c.logic || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(divideMoney(c.total, String(Math.max(1, c.weekly.length))))}</td>
                  <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', c.direction === 'inflow' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{money(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
          {(['ap', 'ar'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSide(s)} className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', side === s ? 'bg-white text-teal-600 shadow-sm dark:bg-slate-700 dark:text-teal-300' : 'text-slate-500 dark:text-slate-400')}>
              {s === 'ap' ? t('toggle.outflowsAp') : t('toggle.inflowsAr')}
            </button>
          ))}
        </div>
        <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmtMoney(total)}</span>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t('footnote.text', { flow: side === 'ap' ? t('footnote.flowAp') : t('footnote.flowAr'), weeks: data.horizonWeeks })}
      </p>
      <Panel title={t('partyPanel.byParty', { side: side === 'ap' ? t('partyPanel.payables') : t('partyPanel.receivables') })} icon={ListOrdered} bodyClassName="p-0">
        <div className="max-h-[30rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('partyTable.party')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('partyTable.items')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('partyTable.amount')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('partyTable.share')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.name} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{e.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{e.count}</td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(e.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{compareMoney(total, '0.0000') > 0 ? formatExactPercent(divideMoney(e.amount, total), 1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

/* -------------------------------------------------------------- primitives */
function Kpi({ icon: Icon, accent, label, value, sub, tone }: { icon: typeof Wallet; accent: string; label: string; value: string; sub?: string; tone?: 'pos' | 'neg' }) {
  const ACCENT: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
    sky: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/50',
    emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/50',
    red: 'bg-red-50 text-red-600 ring-red-100 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900/50',
    amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900/50',
  }
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1', ACCENT[accent])}><Icon size={20} /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{label}</p>
        <p className={cn('truncate text-2xl font-bold tabular-nums', tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{value}</p>
        {sub ? <p className={cn('truncate text-xs font-medium', tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>{sub}</p> : null}
      </div>
    </div>
  )
}
