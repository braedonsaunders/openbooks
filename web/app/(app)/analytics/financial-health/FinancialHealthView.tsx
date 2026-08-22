'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DollarSign, TrendingUp, Scale, Target } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { HealthData } from '../../../../lib/analytics/health-data'
import type { RatioDef } from '../_ui/RatioCard'
import { Gauge } from '../_ui/Gauge'
import { KpiCard } from '../_ui/KpiCard'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { useAnalyticsMoney, fmtPct } from '../_ui/format'
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
type Tab = (typeof TABS)[number]

export function FinancialHealthView({
  data,
  defs,
  budgetsEnabled = true,
}: {
  data: HealthData
  defs: Record<string, RatioDef>
  budgetsEnabled?: boolean
}) {
  const fmtMoney = useAnalyticsMoney()
  const t = useTranslations('analytics.financialHealth')
  const tabs = budgetsEnabled ? TABS : TABS.filter((k) => k !== 'budget')
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const f = data.figures
  const openAccount = (id: string, name: string) => setDrill({ kind: 'account', id, name })

  return (
    <div className="space-y-5">
      {/* Hero KPI row — shared across tabs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Gauge value={data.overallScore} label={t(`score.${data.scoreLabel}`)} size={132} thickness={12} showTicks={false} />
        </div>
        <KpiCard
          icon={DollarSign}
          accent="emerald"
          label={t('kpi.revenue')}
          value={fmtMoney(f.revenue, { compact: true })}
          sub={t('kpiSub.growth', { pct: fmtPct(f.revenueGrowth) })}
          tone={f.revenueGrowth >= 0 ? 'positive' : 'negative'}
        />
        <KpiCard
          icon={TrendingUp}
          accent="teal"
          label={t('kpi.grossMargin')}
          value={fmtPct(f.revenue > 0 ? f.grossProfit / f.revenue : 0)}
          sub={t('kpiSub.grossProfit', { amount: fmtMoney(f.grossProfit, { compact: true }) })}
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
          value={f.breakevenMonthly === null ? '—' : fmtMoney(f.breakevenMonthly, { compact: true })}
          sub={t('kpiSub.perMonth')}
        />
      </div>

      {/* Tab strip */}
      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors',
                tab === k
                  ? 'border-teal-500 text-teal-600 dark:text-teal-400'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {t(`tabs.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Direct keyed render. AnimatePresence's exit-wait deadlocks with these
          heavy multi-chart panels, so we mount the active tab directly. */}
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
        {tab === 'configuration' ? <ConfigurationTab data={data} /> : null}
      </div>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}
