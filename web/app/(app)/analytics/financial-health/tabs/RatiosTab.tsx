'use client'

import { useTranslations } from 'next-intl'
import { Percent, BarChart3, Scale, Gauge as GaugeIcon, Activity } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RatioResult } from '../../../../../lib/analytics/financial-health'
import { RATIO_CATEGORIES, type RatioId } from '../../../../../lib/analytics/ratio-ids'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { decimalRatio } from '../../../../../lib/reports/decimals'
import { KpiCard, type KpiAccent } from '../../_ui/KpiCard'
import { RatioCard, type RatioDef } from '../../_ui/RatioCard'
import { HealthScore } from '../../_ui/HealthScore'
import { Panel } from '../../_ui/Panel'
import { useRatioFormat } from '../../_ui/format'

const GRADE_ACCENT: Record<string, KpiAccent> = { A: 'emerald', B: 'teal', C: 'amber', D: 'amber', F: 'red' }

export function RatiosTab({ data, defs }: { data: HealthData; defs: Record<string, RatioDef> }) {
  const t = useTranslations('analytics.financialHealth')
  const format = useRatioFormat()
  const byId = new Map<RatioId, RatioResult>(Object.values(data.ratios).flat().map((r) => [r.id, r]))

  // Headline ratios read the engine's own results — the same value, grade
  // and reason as their cards below, never a client recomputation.
  const headline = (key: string, id: RatioId, icon: LucideIcon, sub: string) => {
    const r = byId.get(id)!
    return {
      key,
      icon,
      accent: r.grade ? GRADE_ACCENT[r.grade]! : ('slate' as KpiAccent),
      value: format(r.value, r.format) ?? t('ratioCard.notAvailable'),
      sub: r.value === null ? r.unavailable ?? sub : sub,
    }
  }
  const subKpis = [
    headline('roic', 'roic', Percent, t('subKpiSub.returnOnCapital')),
    headline('ebitdaMargin', 'ebitda_margin', BarChart3, t('subKpiSub.earningsMargin')),
    headline('opLeverage', 'operating_leverage', Scale, t('subKpiSub.sensitivity')),
    headline('rule40', 'rule_of_40', GaugeIcon, t('subKpiSub.growthProfit')),
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {subKpis.map((k) => (
          <KpiCard key={k.key} icon={k.icon} accent={k.accent} label={t(`subKpi.${k.key}`)} value={k.value} sub={k.sub} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {RATIO_CATEGORIES.map((cat) => (
            <Panel key={cat} title={t(`categories.${cat}`)} icon={BarChart3} hint={cat === 'profitability' ? t('gridHint') : undefined}>
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
            {data.overallScore === null ? (
              <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">{t('score.notScored')}</p>
            ) : (
              <HealthScore
                score={data.overallScore}
                scoreLabel={t(`score.${data.scoreLabel}`)}
                overallLabel={t('score.overall')}
                categories={data.categoryScores
                  .filter((c): c is { key: typeof c.key; score: number } => c.score !== null)
                  .map((c) => ({ label: t(`categories.${c.key}`), score: c.score }))}
              />
            )}
          </Panel>
          <DuPontPanel data={data} />
        </div>
      </div>
    </div>
  )
}

/** The DuPont decomposition: ROE = Net Margin × Asset Turnover × Equity Multiplier, on the engine's exact figures. */
function DuPontPanel({ data }: { data: HealthData }) {
  const t = useTranslations('analytics.financialHealth.dupont')
  const format = useRatioFormat()
  const f = data.figures
  const roe = Object.values(data.ratios).flat().find((r) => r.id === 'roe')!
  const netMargin = Object.values(data.ratios).flat().find((r) => r.id === 'net_margin')!
  const assetTurnover = Object.values(data.ratios).flat().find((r) => r.id === 'asset_turnover')!
  if (roe.value === null || netMargin.value === null || assetTurnover.value === null) {
    return (
      <Panel title={t('title')} icon={Scale}>
        <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">{roe.unavailable ?? netMargin.unavailable ?? assetTurnover.unavailable}</p>
      </Panel>
    )
  }
  const equityMultiplier = decimalRatio(f.totalAssets, f.totalEquity)
  const row = (label: string, value: string | null, sub: string) => (
    <li className="flex items-center justify-between py-2">
      <span>
        <span className="block text-sm text-slate-600 dark:text-slate-300">{label}</span>
        <span className="block text-[11px] text-slate-400 dark:text-slate-500">{sub}</span>
      </span>
      <span className="text-sm font-semibold text-slate-800 tabular-nums dark:text-slate-100">{value ?? '—'}</span>
    </li>
  )
  const negative = roe.value.startsWith('-')
  return (
    <Panel title={t('title')} icon={Scale} hint={t('hint')}>
      <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
        {row(t('netMargin'), format(netMargin.value, 'pct'), t('netMarginSub'))}
        {row(t('assetTurnover'), format(assetTurnover.value, 'times'), t('assetTurnoverSub'))}
        {row(t('equityMultiplier'), format(equityMultiplier, 'times'), t('equityMultiplierSub'))}
        <li className="flex items-center justify-between py-2">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('roe')}</span>
          <span className={negative ? 'text-sm font-bold text-red-600 tabular-nums dark:text-red-400' : 'text-sm font-bold text-emerald-600 tabular-nums dark:text-emerald-400'}>{format(roe.value, 'pct')}</span>
        </li>
      </ul>
    </Panel>
  )
}
