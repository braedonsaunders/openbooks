'use client'

import { useTranslations } from 'next-intl'
import { Percent, BarChart3, Scale, Gauge as GaugeIcon, Activity } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RatioCategory } from '../../../../../lib/analytics/financial-health'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { KpiCard, type KpiAccent } from '../../_ui/KpiCard'
import { RatioCard, type RatioDef } from '../../_ui/RatioCard'
import { HealthScore } from '../../_ui/HealthScore'
import { Panel } from '../../_ui/Panel'
import { fmtPct } from '../../_ui/format'

export function RatiosTab({ data, defs }: { data: HealthData; defs: Record<string, RatioDef> }) {
  const t = useTranslations('analytics.financialHealth')
  const f = data.figures

  const subKpis: { key: string; icon: LucideIcon; accent: KpiAccent; value: string; sub: string; tone?: 'positive' | 'negative' | 'neutral' }[] = [
    { key: 'roic', icon: Percent, accent: 'sky', value: data.hasBalanceSheet ? fmtPct(f.investedCapital > 0 ? (f.operatingIncome * 0.75) / f.investedCapital : 0) : 'N/A', sub: t('subKpiSub.returnOnCapital') },
    { key: 'ebitdaMargin', icon: BarChart3, accent: 'emerald', value: fmtPct(f.revenue > 0 ? f.ebitda / f.revenue : 0), sub: t('subKpiSub.earningsMargin') },
    { key: 'opLeverage', icon: Scale, accent: 'violet', value: `${f.operatingLeverage.toFixed(2)}x`, sub: t('subKpiSub.sensitivity') },
    { key: 'rule40', icon: GaugeIcon, accent: f.rule40 >= 40 ? 'emerald' : f.rule40 >= 20 ? 'amber' : 'red', value: f.rule40.toFixed(1), sub: t('subKpiSub.growthProfit'), tone: f.rule40 >= 40 ? 'positive' : f.rule40 >= 20 ? 'neutral' : 'negative' },
  ]

  const grids: RatioCategory[] = ['profitability', 'efficiency', 'operating']
  const catLabel: Record<RatioCategory, string> = {
    profitability: t('categories.profitability'),
    efficiency: t('categories.efficiency'),
    operating: t('categories.operating'),
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {subKpis.map((k) => (
          <KpiCard key={k.key} icon={k.icon} accent={k.accent} label={t(`subKpi.${k.key}`)} value={k.value} sub={k.sub} tone={k.tone} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {grids.map((cat) => (
            <Panel key={cat} title={catLabel[cat]} icon={BarChart3} hint={cat === 'profitability' ? t('gridHint') : undefined}>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                {data.ratios[cat].map((r) => (
                  <RatioCard key={r.id} data={r} def={defs[r.id]!} />
                ))}
              </div>
            </Panel>
          ))}
        </div>
        <div className="space-y-5">
          <Panel title={t('score.title')} icon={Activity}>
            <HealthScore
              score={data.overallScore}
              scoreLabel={t(`score.${data.scoreLabel}`)}
              overallLabel={t('score.overall')}
              categories={data.categoryScores.map((c) => ({ label: t(`categories.${c.key}`), score: c.score }))}
            />
          </Panel>
          <DuPontPanel data={data} />
        </div>
      </div>
    </div>
  )
}

/** the DuPont decomposition: ROE = Net Margin × Asset Turnover × Equity Multiplier. */
function DuPontPanel({ data }: { data: HealthData }) {
  const f = data.figures
  if (!data.hasBalanceSheet || Math.abs(f.totalEquity) < 0.005) {
    return (
      <Panel title="DuPont Analysis" icon={Scale}>
        <p className="py-4 text-center text-xs text-slate-400">Needs balance sheet data (assets & equity) to decompose ROE.</p>
      </Panel>
    )
  }
  const netMargin = f.revenue > 0 ? f.netIncome / f.revenue : 0
  const assetTurnover = f.totalAssets > 0 ? f.revenue / f.totalAssets : 0
  const equityMultiplier = f.totalEquity !== 0 ? f.totalAssets / f.totalEquity : 0
  const roe = netMargin * assetTurnover * equityMultiplier
  const row = (label: string, value: string, sub: string) => (
    <li className="flex items-center justify-between py-2">
      <span>
        <span className="block text-sm text-slate-600 dark:text-slate-300">{label}</span>
        <span className="block text-[11px] text-slate-400 dark:text-slate-500">{sub}</span>
      </span>
      <span className="text-sm font-semibold text-slate-800 tabular-nums dark:text-slate-100">{value}</span>
    </li>
  )
  return (
    <Panel title="DuPont Analysis" icon={Scale} hint="ROE = Net Margin × Asset Turnover × Equity Multiplier">
      <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
        {row('Net Margin', fmtPct(netMargin), 'Net income ÷ revenue')}
        {row('Asset Turnover', `${assetTurnover.toFixed(2)}×`, 'Revenue ÷ total assets')}
        {row('Equity Multiplier', `${equityMultiplier.toFixed(2)}×`, 'Assets ÷ equity (leverage)')}
        <li className="flex items-center justify-between py-2">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Return on Equity</span>
          <span className={roe >= 0 ? 'text-sm font-bold text-emerald-600 tabular-nums dark:text-emerald-400' : 'text-sm font-bold text-red-600 tabular-nums dark:text-red-400'}>{fmtPct(roe)}</span>
        </li>
      </ul>
    </Panel>
  )
}
