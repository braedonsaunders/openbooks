'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { ArrowUpRight, ArrowDownRight, ArrowRight, Users, TrendingUp, TrendingDown, ShieldCheck, MailWarning, CheckCircle2, Clock3, CreditCard, ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { cmp, neg } from '@openbooks/engine/money'
import { Button, cn } from '@openbooks/ui'
import { RecordTabs } from '@/components/module-home/record-tabs'
import { SearchInput } from '@/components/search-input'
import { RelatedPartyLink } from '@/components/related-party-link'
import { ANALYTICS_TABS } from '../../../../lib/analytics/dashboard-tabs'
import type { CollectionCustomer, ReceivablesIntelligence } from '../../../../lib/analytics/receivables-intelligence-data'
import { collectionCustomerReasons, sparklineCoordinates, receivablesRatio } from '../../../../lib/analytics/receivables-metrics'
import { AnalyticsTabContent, useAnalyticsTab } from '../use-analytics-tab'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { Chart, Donut, GroupedBar, TrendChart, Waterfall } from '../_ui/charts'
import { useAnalyticsMoney, toChartNumber, escapeTooltipHtml } from '../_ui/format'

const TABS = ANALYTICS_TABS['receivables-intelligence']
const SIGNALS = ['all', 'deteriorating', 'severe', 'delivery', 'terms', 'held'] as const

type DashboardData = ReceivablesIntelligence & { canConfigure: boolean }

export function ReceivablesView({ data: initialData, canOpenCustomers = false }: { data: DashboardData; canOpenCustomers?: boolean }) {
  const t = useTranslations('analytics.receivables')
  const locale = useLocale()
  const search = useSearchParams()
  const read = useAnalyticsTab('receivables-intelligence', { data: initialData, canOpenCustomers }, TABS)
  const { data } = read.props
  const s = data.summary
  const fmt = useAnalyticsMoney()
  const money = (amount: string) => fmt(amount, { compact: true })
  const number = (value: number | string | null, decimals = 0) => value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(Number(value))
  const percent = (value: string | null) => value === null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(Number(value))
  const date = (value: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
  const update = (key: string, value?: string) => {
    const url = new URL(window.location.href)
    if (value && value !== 'all') url.searchParams.set(key, value)
    else url.searchParams.delete(key)
    if (key !== 'customerPage') url.searchParams.delete('customerPage')
    window.history.replaceState(null, '', url)
  }
  const controls = <div className="flex flex-wrap items-center gap-2">
    <SearchInput placeholder={t('search')} paramKey="customerQ" pageParamKey="customerPage" size="md" className="w-full sm:w-80" />
    <select aria-label={t('filter')} value={search.get('signal') ?? 'all'} onChange={(e) => update('signal', e.target.value)} className="h-9 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
      {SIGNALS.filter((key) => key !== 'held' || data.currentCredit).map((key) => <option key={key} value={key}>{t(`signals.${key}`)}</option>)}
    </select>
  </div>
  const customers = <>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {data.customers.map((customer) => <CustomerCard key={customer.id ?? 'unassigned'} customer={customer} canOpen={read.props.canOpenCustomers} currentCredit={data.currentCredit} minObservations={data.minObservations} />)}
    </div>
    {data.customers.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center dark:border-slate-800"><Users size={28} className="mx-auto mb-3 text-slate-300" /><p className="text-sm font-medium text-slate-600 dark:text-slate-300">{t('noCustomers')}</p><p className="mt-1 text-xs text-slate-400">{t('noCustomersHint')}</p></div>}
    {data.customerTotal > 0 && <div className="flex items-center justify-between gap-3 text-xs text-slate-500"><span>{t('showing', { from: number((data.customerPage - 1) * 24 + 1), to: number(Math.min(data.customerPage * 24, data.customerTotal)), total: number(data.customerTotal) })}</span><div className="flex gap-1"><Button variant="secondary" size="sm" disabled={data.customerPage === 1} aria-label={t('previous')} onClick={() => update('customerPage', String(data.customerPage - 1))}><ChevronLeft size={14} /></Button><Button variant="secondary" size="sm" disabled={data.customerPage * 24 >= data.customerTotal} aria-label={t('next')} onClick={() => update('customerPage', String(data.customerPage + 1))}><ChevronRight size={14} /></Button></div></div>}
  </>
  const report = `/reports/aging?side=ar&period=custom&from=${data.asOf}&to=${data.asOf}&asOf=${data.asOf}`
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <KpiCard icon={Users} accent="amber" label={t('kpi.attention')} value={money(s.attention)} sub={t('customerCount', { count: s.attentionCustomers })} />
      <KpiCard icon={TrendingDown} accent="violet" label={t('kpi.deteriorating')} value={number(s.deterioratingCustomers)} sub={t('exposure', { amount: money(s.deterioratingExposure) })} />
      <KpiCard icon={CheckCircle2} accent="teal" label={t('kpi.recovery')} value={percent(s.recoveryShare)} sub={t('recovered', { amount: money(s.recovered) })} />
      <KpiCard icon={Clock3} accent="sky" label={t('kpi.onTime')} value={percent(s.onTimeShare)} sub={t('behaviorWindow', { days: data.baselineDays })} />
    </div>
    <RecordTabs label={t('title')} tabs={TABS.map((key) => ({ key, label: t(`tabs.${key}`) }))} active={read.tab} onChange={read.setTab}>
      <AnalyticsTabContent loading={read.loading} error={read.error} retry={read.retry}>
        <div className="space-y-4" key={read.tab}>
          {read.tab === 'customers' && <>
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('portfolio')}</h2><p className="mt-0.5 text-xs text-slate-400">{t('portfolioHint', { count: s.customers })}</p></div>{controls}</div>
            {customers}
          </>}
          {read.tab === 'behavior' && <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title={t('panels.behavior')} icon={Clock3} hint={t('cashWeighted')}>{s.behavior.length === 0 ? <p className="py-20 text-center text-xs text-slate-400">{t('noPaymentHistory')}</p> : <Donut data={s.behavior.map((row) => ({ name: t(`behavior.${row.index}`), value: toChartNumber(row.amount) }))} height={240} colors={['#0d9488', '#38bdf8', '#f59e0b', '#ef4444']} />}</Panel>
              <Panel title={t('panels.behaviorTrend')} icon={TrendingUp} hint={t('cashWeighted')}><TrendChart labels={data.trend.map((row) => date(row.date))} format="count" series={[{ name: t('daysBeyondTerms'), data: data.trend.map((row) => row.days === null ? null : Number(row.days)), color: '#6366f1' }]} height={240} /></Panel>
            </div>
            <Panel title={t('panels.paymentMap')} icon={Users} hint={t('mapHint')}><Chart height={260} option={{ grid: { left: 45, right: 25, top: 20, bottom: 45 }, tooltip: { trigger: 'item', formatter: (p: { data: { name: string; value: number[] } }) => `${escapeTooltipHtml(p.data.name)}<br/>${escapeTooltipHtml(t('changeLabel'))}: ${number(p.data.value[0]!, 1)}<br/>${escapeTooltipHtml(t('overdue'))}: ${escapeTooltipHtml(money(String(p.data.value[1]!)))}` }, xAxis: { type: 'value', name: t('changeLabel'), nameLocation: 'middle', nameGap: 28, axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } } }, yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v: number) => money(String(v)) }, splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } } }, series: [{ type: 'scatter', symbolSize: 13, data: data.customers.filter((c) => c.changeDays !== null && c.observations >= data.minObservations && c.baselineObservations >= data.minObservations).map((c) => ({ name: c.id ? c.name : t('unassigned'), value: [Number(c.changeDays), toChartNumber(c.overdue)], itemStyle: { color: c.deteriorating ? '#f59e0b' : '#0d9488', opacity: .8 } })) }] }} /></Panel>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-slate-400">{t('baselineHint', { days: data.baselineDays, count: data.minObservations })}</p>{controls}</div>
            {customers}
          </>}
          {read.tab === 'recovery' && <>
            {cmp(s.opening, '0') <= 0 ? <Empty title={t('noOpening')} body={t('noOpeningHint')} /> : <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title={t('panels.recoveryBridge')} icon={CheckCircle2} hint={t('fixedCohort')}><Waterfall height={260} steps={[{ label: t('openingOverdue'), amount: toChartNumber(s.opening), kind: 'start' }, { label: t('cashRecovered'), amount: toChartNumber(neg(s.recovered)), kind: 'deduct' }, { label: t('otherChanges'), amount: toChartNumber(neg(s.otherChange)), kind: 'deduct' }, { label: t('stillOpen'), amount: toChartNumber(s.remaining), kind: 'total' }]} /></Panel>
                <Panel title={t('panels.cohortRecovery')} icon={Users} hint={t('fixedCohort')}><GroupedBar height={260} labels={data.recovery.map((row) => t(`recoveryCohort.${row.index}`))} series={[{ name: t('openingOverdue'), data: data.recovery.map((row) => toChartNumber(row.opening)), color: '#94a3b8' }, { name: t('cashRecovered'), data: data.recovery.map((row) => toChartNumber(row.cash)), color: '#0d9488' }, { name: t('stillOpen'), data: data.recovery.map((row) => toChartNumber(row.remaining)), color: '#f59e0b' }]} /></Panel>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{data.recovery.map((row) => <RecoveryCard key={row.index} row={row} />)}</div>
            </>}
            <Panel title={t('panels.appliedCash')} icon={CreditCard} hint={t('appliedCashHint')}><TrendChart labels={data.trend.map((row) => date(row.date))} series={[{ name: t('appliedCash'), data: data.trend.map((row) => toChartNumber(row.amount)), color: '#0d9488' }]} area height={230} /></Panel>
          </>}
          {read.tab === 'collections' && <>
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title={t('panels.delivery')} icon={MailWarning} className="lg:col-span-1" hint={t('deliveryHint')}>{s.notices.length === 0 ? <p className="py-20 text-center text-xs text-slate-400">{t('noReminders')}</p> : <Donut height={240} valueFormat={(v) => number(v)} colors={s.notices.map((r) => r.status === 'sent' ? '#0d9488' : r.status === 'staged' ? '#38bdf8' : '#f59e0b')} data={s.notices.map((r) => ({ name: t(`notice.${r.status}`), value: r.documents }))} />}</Panel>
              <Panel title={t('panels.reminderCoverage')} icon={ShieldCheck} className="lg:col-span-2"><div className="grid gap-6 sm:grid-cols-2"><div><p className="text-4xl font-semibold tracking-tight text-teal-600 tabular-nums">{percent(s.coverageShare)}</p><p className="mt-2 text-sm font-medium text-slate-600 dark:text-slate-300">{t('reminderCoverage')}</p><p className="mt-1 text-xs text-slate-400">{t('coverageCount', { sent: s.deliveredDocuments, total: s.overdueDocuments })}</p></div><div><p className="text-4xl font-semibold tracking-tight text-amber-600 tabular-nums">{data.currentCredit ? money(s.failedExposure) : '—'}</p><p className="mt-2 text-sm font-medium text-slate-600 dark:text-slate-300">{t('failedExposure')}</p><p className="mt-1 text-xs text-slate-400">{data.currentCredit ? t('deliveryRemedy') : t('historicalDelivery')}</p></div></div><p className="mt-6 border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-400 dark:border-slate-800">{t('coverageScope')}</p></Panel>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('deliveryCustomers')}</h2>{controls}</div>
            {customers}
          </>}
          {read.tab === 'credit' && <>
            {!data.currentCredit ? <Empty title={t('creditCurrentOnly')} body={t('creditCurrentHint')} action={<Link href="?period=today&tab=credit" className="inline-flex items-center gap-1 text-sm font-medium text-teal-600">{t('reviewCurrent')}<ArrowRight size={14} /></Link>} /> : <>
              <div className="grid gap-3 md:grid-cols-3"><KpiCard icon={ShieldCheck} accent="amber" label={t('creditHeld')} value={number(s.heldCustomers)} sub={t('exposure', { amount: money(s.heldExposure) })} /><KpiCard icon={CreditCard} accent="red" label={t('creditExceeded')} value={number(s.overLimitCustomers)} sub={t('excess', { amount: money(s.overLimit) })} /><KpiCard icon={Users} accent="sky" label={t('creditConfigured')} value={number(s.limitCustomers)} sub={t('customerCount', { count: s.customers })} /></div>
              <Panel title={t('panels.creditWatch')} icon={ShieldCheck} hint={t('creditBasis')}><div className="mb-4 flex flex-wrap justify-end gap-2">{controls}</div>{customers}</Panel>
            </>}
          </>}
          {read.tab === 'configuration' && <ConfigEditor dashboard="receivables" canEdit={data.canConfigure} />}
        </div>
      </AnalyticsTabContent>
    </RecordTabs>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"><span>{t('dataDate', { date: date(data.asOf), currency: data.currency })}</span><Link href={report} className="inline-flex items-center gap-1 font-medium text-teal-600 hover:underline dark:text-teal-400">{t('openReport')}<ArrowUpRight size={13} /></Link></div>
  </div>
}

function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <Panel title={title} icon={Info}><div className="py-8 text-center"><p className="mx-auto max-w-lg text-sm leading-relaxed text-slate-500">{body}</p>{action && <div className="mt-4">{action}</div>}</div></Panel>
}

function CustomerCard({ customer: c, canOpen, currentCredit, minObservations }: { customer: CollectionCustomer; canOpen: boolean; currentCredit: boolean; minObservations: number }) {
  const t = useTranslations('analytics.receivables')
  const locale = useLocale()
  const fmt = useAnalyticsMoney()
  const money = (v: string) => fmt(v, { compact: true })
  const days = (v: string | null) => v === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Number(v))
  const reasons = collectionCustomerReasons(c)
  const change = c.changeDays === null || c.observations < minObservations || c.baselineObservations < minObservations ? null : Number(c.changeDays)
  const path = sparklineCoordinates(c.history.map((h) => h.days === null ? null : Number(h.days)))
  const customerName = c.id ? c.name : t('unassigned')
  return <article className={cn('group overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md dark:bg-slate-900', reasons.length ? 'border-amber-200/70 dark:border-amber-900/60' : 'border-slate-200 dark:border-slate-800')}>
    <div className="p-4">
      <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2.5"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-teal-50 text-xs font-bold text-teal-700 dark:bg-teal-950 dark:text-teal-300">{customerName.slice(0, 2).toLocaleUpperCase(locale)}</div>{c.id && canOpen ? <RelatedPartyLink partyId={c.id} role="customer" className="truncate text-sm font-semibold text-slate-800 hover:text-teal-600 dark:text-slate-100">{customerName}</RelatedPartyLink> : <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{customerName}</span>}</div>{c.id && canOpen && <RelatedPartyLink partyId={c.id} role="customer" className="rounded-md p-1 text-slate-400 hover:bg-teal-50 hover:text-teal-600 dark:hover:bg-teal-950"><span className="sr-only">{t('openCustomer', { name: customerName })}</span><ArrowUpRight size={16} /></RelatedPartyLink>}</div>
      <div className="mt-4 flex items-end justify-between gap-3"><div><p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{t('overdue')}</p><p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-100">{money(c.overdue)}</p><p className="mt-0.5 text-xs text-slate-400">{t('openExposure', { amount: money(c.gross) })}</p></div><div className="w-24 text-right">{path.length > 0 && <svg viewBox="0 0 100 32" className={cn('h-8 w-24', c.deteriorating ? 'text-amber-500' : 'text-teal-500')} role="img" aria-label={t('paymentSparkline')}><polyline points={path.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}{change !== null ? <p className={cn('mt-1 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums', change > 0 ? 'text-amber-600' : 'text-teal-600')}>{change > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{t('changeDays', { days: days(String(Math.abs(change))) })}</p> : <p className="mt-1 text-[10px] text-slate-400">{t('insufficientHistory')}</p>}</div></div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800"><div><p className="text-slate-400">{t('recentPayment')}</p><p className="mt-0.5 font-semibold text-slate-700 tabular-nums dark:text-slate-200">{t('dayValue', { days: days(c.recentDays) })}</p></div><div><p className="text-slate-400">{t('baselinePayment')}</p><p className="mt-0.5 font-semibold text-slate-700 tabular-nums dark:text-slate-200">{t('dayValue', { days: days(c.baselineDays) })}</p></div><p className="col-span-2 text-[10px] text-slate-400">{t('observationCount', { recent: c.observations, baseline: c.baselineObservations })}</p></div>
      {currentCredit && c.headroom !== null && <div className="mt-2 flex items-center justify-between text-xs"><span className="text-slate-400">{t('headroom')}</span><span className={cn('font-semibold tabular-nums', cmp(c.headroom, '0') > 0 ? 'text-teal-600' : 'text-amber-600')}>{money(c.headroom)}</span></div>}
      <div className="mt-3 flex min-h-5 flex-wrap gap-1.5">{reasons.length ? reasons.map((reason) => <span key={reason} className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">{t(`reasons.${reason}`)}</span>) : <span className="inline-flex items-center gap-1 text-[10px] text-teal-600"><CheckCircle2 size={11} />{t('noFlags')}</span>}</div>
      {c.lastNotice && <p className="mt-2 text-[10px] text-slate-400">{t('lastNotice', { date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${c.lastNotice}T00:00:00Z`)) })}</p>}
      {c.held && c.holdReason && <p className="mt-2 line-clamp-2 text-[10px] text-amber-600">{c.holdReason}</p>}
    </div>
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-[10px] text-slate-500 dark:border-slate-800 dark:bg-slate-950/30"><span>{t('customerDocuments', { count: c.documents })}{cmp(c.credits, '0') > 0 ? ` · ${t('customerCredits', { amount: money(c.credits) })}` : ''}</span>{currentCredit && c.creditLimit !== null ? <span>{t('creditLimit', { amount: money(c.creditLimit) })}</span> : <span>{t('oldestDays', { days: c.oldestDays })}</span>}</div>
  </article>
}

function RecoveryCard({ row }: { row: ReceivablesIntelligence['recovery'][number] }) {
  const t = useTranslations('analytics.receivables')
  const locale = useLocale()
  const fmt = useAnalyticsMoney()
  const share = Number(receivablesRatio(row.cash, row.opening) ?? '0')
  return <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><p className="text-xs font-medium text-slate-500">{t(`recoveryCohort.${row.index}`)}</p><p className="mt-2 text-2xl font-semibold text-teal-600 tabular-nums">{new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(share)}</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-teal-500" style={{ width: `${share * 100}%` }} /></div><p className="mt-2 text-xs text-slate-400">{t('recoveredOf', { cash: fmt(row.cash, { compact: true }), opening: fmt(row.opening, { compact: true }) })}</p></div>
}
