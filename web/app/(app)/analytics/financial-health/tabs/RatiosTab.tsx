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
        <div>
          <Panel title={t('score.title')} icon={Activity}>
            <HealthScore
              score={data.overallScore}
              scoreLabel={t(`score.${data.scoreLabel}`)}
              overallLabel={t('score.overall')}
              categories={data.categoryScores.map((c) => ({ label: t(`categories.${c.key}`), score: c.score }))}
            />
          </Panel>
        </div>
      </div>
    </div>
  )
}
