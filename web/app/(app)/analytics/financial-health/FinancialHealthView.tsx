'use client'

import { useAnalyticsTab, AnalyticsTabContent } from '../use-analytics-tab'

import { RecordTabs } from '@/components/module-home/record-tabs'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DollarSign, TrendingUp, Scale, Target } from 'lucide-react'
import type { HealthData } from '../../../../lib/analytics/health-data'
import type { RatioDef } from '../_ui/RatioCard'
import { Gauge } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { useAnalyticsMoney, useRatioFormat } from '../_ui/format'
import { OverviewTab } from './tabs/OverviewTab'
import { MarginTab } from './tabs/MarginTab'
import { ItemsTab } from './tabs/ItemsTab'
import { SegmentsTab } from './tabs/SegmentsTab'
import { ForecastTab } from './tabs/ForecastTab'
import { ScenariosTab } from './tabs/ScenariosTab'
import { BudgetTab } from './tabs/BudgetTab'
import { DriversTab } from './tabs/DriversTab'
import { RatiosTab } from './tabs/RatiosTab'
import { ConfigurationTab } from './tabs/ConfigurationTab'

const TABS = ['overview', 'margin', 'items', 'segments', 'forecast', 'scenarios', 'budget', 'drivers', 'ratios', 'configuration'] as const

export function FinancialHealthView({
  data: initialData,
  defs,
  budgetsEnabled = true,
  canConfigure,
}: {
  data: HealthData
  defs: Record<string, RatioDef>
  budgetsEnabled?: boolean
  canConfigure?: boolean
}) {
  const fmtMoney = useAnalyticsMoney()
  const fmtRatio = useRatioFormat()
  const t = useTranslations('analytics.financialHealth')
  const tabs = budgetsEnabled ? TABS : TABS.filter((k) => k !== 'budget')
  const read = useAnalyticsTab('financial-health', { data: initialData }, tabs)
  const { tab, setTab } = read
  const { data } = read.props
  const grossMargin = Object.values(data.ratios).flat().find((r) => r.id === 'gross_margin')!
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const f = data.figures
  const openAccount = (id: string, name: string) => setDrill({ kind: 'account', id, name })

  return (
    <div className="space-y-5">
      {/* Hero KPI row — shared across tabs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge
            value={data.overallScore ?? 0}
            label={data.scoreLabel ? t(`score.${data.scoreLabel}`) : t('score.unscored')}
            size={132}
            thickness={12}
            showTicks={false}
          />
        </div>
        <KpiCard
          icon={DollarSign}
          accent="emerald"
          label={t('kpi.revenue')}
          value={fmtMoney(f.revenue, { compact: true })}
          sub={f.revenueGrowth === null ? t('kpiSub.noPriorYear') : t('kpiSub.growth', { pct: fmtRatio(f.revenueGrowth, 'pct') ?? '' })}
          tone={f.revenueGrowth === null ? undefined : f.revenueGrowth.startsWith('-') ? 'negative' : 'positive'}
        />
        <KpiCard
          icon={TrendingUp}
          accent="teal"
          label={t('kpi.grossMargin')}
          value={fmtRatio(grossMargin.value, 'pct') ?? '—'}
          sub={grossMargin.value === null ? grossMargin.unavailable ?? '' : t('kpiSub.grossProfit', { amount: fmtMoney(f.grossProfit, { compact: true }) })}
        />
        <KpiCard
          icon={Scale}
          accent="violet"
          label={t('kpi.operatingIncome')}
          value={fmtMoney(f.operatingIncome, { compact: true })}
          sub={t('kpiSub.opex', { amount: fmtMoney(f.opex, { compact: true }) })}
        />
        <KpiCard
          icon={Target}
          accent="amber"
          label={t('kpi.breakeven')}
          value={f.breakevenRevenue === null ? '—' : fmtMoney(f.breakevenRevenue, { compact: true })}
          sub={f.breakevenRevenue === null ? t('kpiSub.noBreakeven') : t('kpiSub.forPeriod')}
        />
      </div>

      {/* Tab strip */}
      <RecordTabs label={t('title')} tabs={tabs.map((k) => ({ key: k, label: t(`tabs.${k}`) }))} active={tab} onChange={setTab}>
      <AnalyticsTabContent loading={read.loading} error={read.error} retry={read.retry}>
      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'margin' ? <MarginTab data={data} /> : null}
        {tab === 'items' ? <ItemsTab data={data} onDrill={openAccount} /> : null}
        {tab === 'segments' ? <SegmentsTab data={data} /> : null}
        {tab === 'forecast' ? <ForecastTab data={data} /> : null}
        {tab === 'scenarios' ? <ScenariosTab data={data} /> : null}
        {tab === 'budget' && budgetsEnabled ? <BudgetTab data={data} /> : null}
        {tab === 'drivers' ? <DriversTab data={data} onDrill={openAccount} /> : null}
        {tab === 'ratios' ? <RatiosTab data={data} defs={defs} /> : null}
        {tab === 'configuration' ? <ConfigurationTab canEdit={canConfigure ?? false} benchmarks={data.benchmarks} /> : null}
      </div>
            </AnalyticsTabContent>
      </RecordTabs>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}
