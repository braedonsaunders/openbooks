'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowUpRight, Banknote, Clock, AlertCircle, Users, PieChart, CalendarClock, Info } from 'lucide-react'
import { neg } from '@openbooks/engine/money'
import { RecordTabs } from '@/components/module-home/record-tabs'
import { ANALYTICS_TABS } from '../../../../lib/analytics/dashboard-tabs'
import type { ReceivablesData } from '../../../../lib/analytics/receivables-data'
import { cumulativeReceivableMaturity, receivablesRatio } from '../../../../lib/analytics/receivables-metrics'
import { AnalyticsTabContent, useAnalyticsTab } from '../use-analytics-tab'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { Donut, DivergingBar, TrendChart } from '../_ui/charts'
import { useAnalyticsMoney, toChartNumber } from '../_ui/format'
import { RelatedPartyLink } from '../../../../components/related-party-link'

const TABS = ANALYTICS_TABS['receivables-intelligence']

export function ReceivablesView({ data: initialData, canOpenCustomers = false }: { data: ReceivablesData; canOpenCustomers?: boolean }) {
  const t = useTranslations('analytics.receivables')
  const locale = useLocale()
  const fmt = useAnalyticsMoney()
  const money = (amount: string) => fmt(amount, { compact: true })
  const percent = (value: string | null) => value === null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(Number(value))
  const days = (value: string | null) => value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Number(value))
  const read = useAnalyticsTab('receivables-intelligence', { data: initialData, canOpenCustomers }, TABS)
  const { data } = read.props
  const s = data.summary
  const reportHref = `/reports/aging?side=ar&period=custom&from=${data.asOf}&to=${data.asOf}&asOf=${data.asOf}`
  const ageLabels = s.aging.map((r) => t(`aging.${r.index}`))
  const maturityLabels = s.maturity.map((r) => t(`maturity.${r.index}`))
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <KpiCard icon={Banknote} accent="teal" label={t('kpi.outstanding')} value={money(s.outstanding)} sub={t('documents', { count: s.documents })} />
      <KpiCard icon={AlertCircle} accent="amber" label={t('kpi.overdue')} value={money(s.overdue)} sub={t('grossBasis')} />
      <KpiCard icon={PieChart} accent="violet" label={t('kpi.overdueShare')} value={percent(s.overdueShare)} sub={t('grossBasis')} />
      <KpiCard icon={Clock} accent="sky" label={t('kpi.averageDays')} value={days(s.averageOverdueDays)} sub={t('weightedBasis')} />
    </div>
    <RecordTabs label={t('title')} tabs={TABS.map((key) => ({ key, label: t(`tabs.${key}`) }))} active={read.tab} onChange={read.setTab}>
      <AnalyticsTabContent loading={read.loading} error={read.error} retry={read.retry}>
        <div className="space-y-5" key={read.tab}>
          {s.documents === 0 ? <Panel title={t('emptyTitle')} icon={Banknote}><p className="py-12 text-center text-sm text-slate-500">{t('emptyBody')}</p></Panel> : <>
            {read.tab === 'overview' && <>
              <div className="grid gap-5 lg:grid-cols-3">
                <Panel title={t('panels.aging')} icon={PieChart} hint={t('grossBasis')}>
                  <Donut data={s.aging.map((r) => ({ name: t(`aging.${r.index}`), value: toChartNumber(r.gross) })).filter((r) => r.value > 0)} height={250} />
                </Panel>
                <Panel title={t('panels.balanceBridge')} icon={Banknote} className="lg:col-span-2">
                  <DivergingBar labels={[t('kpi.gross'), t('kpi.credits'), t('kpi.outstanding')]} values={[toChartNumber(s.gross), toChartNumber(neg(s.credits)), toChartNumber(s.outstanding)]} height={250} />
                </Panel>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <KpiCard icon={Users} accent="violet" label={t('kpi.customers')} value={new Intl.NumberFormat(locale).format(s.customers)} sub={t('openCustomerBasis')} />
                <KpiCard icon={AlertCircle} accent="red" label={t('kpi.severe')} value={money(s.severe)} sub={t('aging.4')} />
                <KpiCard icon={PieChart} accent="sky" label={t('kpi.top5')} value={percent(s.top5Share)} sub={t('grossBasis')} />
              </div>
            </>}
            {read.tab === 'aging' && <>
              <div className="grid gap-5 lg:grid-cols-2">
                <Panel title={t('panels.agingBalances')} icon={Banknote}>
                  <DivergingBar labels={ageLabels} values={s.aging.map((r) => toChartNumber(r.gross))} height={280} />
                </Panel>
                <Panel title={t('panels.agingCredits')} icon={Banknote}>
                  <DivergingBar labels={ageLabels} values={s.aging.map((r) => toChartNumber(neg(r.credits)))} height={280} />
                </Panel>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {s.aging.map((r) => <KpiCard key={r.index} icon={Clock} accent={r.index >= 3 ? 'amber' : 'teal'} label={t(`aging.${r.index}`)} value={money(r.net)} sub={t('cohort', { count: r.documents, days: days(r.averageDays) })} />)}
              </div>
            </>}
            {read.tab === 'customers' && <>
              <Panel title={t('panels.customerExposure')} icon={Users} hint={t('topCustomers')}>
                <DivergingBar labels={data.customers.map((r) => r.id ? r.name : t('unassigned'))} values={data.customers.map((r) => toChartNumber(r.overdue))} height={Math.max(240, data.customers.length * 32)} />
              </Panel>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {data.customers.map((r) => {
                  const content = <>
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{r.id ? r.name : t('unassigned')}</span>{r.id && read.props.canOpenCustomers && <ArrowUpRight size={15} className="shrink-0 text-teal-500" />}</div>
                    <p className="mt-3 text-2xl font-bold tabular-nums">{money(r.net)}</p>
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('customerShare', { share: percent(receivablesRatio(r.gross, s.gross)), overdue: money(r.overdue) })}</p>
                    <p className="mt-1 text-xs text-slate-500">{t('documents', { count: r.documents })} · {t('kpi.credits')}: {money(r.credits)}</p>
                  </>
                  const className = 'rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-teal-400 focus-visible:outline-2 focus-visible:outline-teal-500 dark:border-slate-800 dark:bg-slate-900'
                  return r.id && read.props.canOpenCustomers ? <RelatedPartyLink key={r.id} partyId={r.id} role="customer" className={className}>{content}</RelatedPartyLink>
                    : <div key={r.id ?? 'unassigned'} className={className}>{content}</div>
                })}
              </div>
            </>}
            {read.tab === 'maturity' && <>
              <Panel title={t('panels.maturity')} icon={CalendarClock} hint={t('contractualBasis')}>
                <DivergingBar labels={maturityLabels} values={s.maturity.map((r) => toChartNumber(r.gross))} height={280} />
              </Panel>
              <Panel title={t('panels.cumulative')} icon={CalendarClock}>
                <TrendChart labels={maturityLabels} series={[{ name: t('kpi.gross'), data: cumulativeReceivableMaturity(s.maturity).map(toChartNumber), color: '#0d9488' }]} area height={220} />
              </Panel>
            </>}
          </>}
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-teal-50 p-4 text-xs leading-relaxed text-teal-900 dark:bg-teal-950/30 dark:text-teal-200">
            <p className="flex max-w-3xl gap-2"><Info size={15} className="mt-0.5 shrink-0" /><span>{t('methodology', { currency: data.currency, terms: money(s.missingTerms) })}</span></p>
            <Link href={reportHref} className="inline-flex shrink-0 items-center gap-1 font-semibold underline underline-offset-4">{t('openReport')}<ArrowUpRight size={14} /></Link>
          </div>
        </div>
      </AnalyticsTabContent>
    </RecordTabs>
  </div>
}
