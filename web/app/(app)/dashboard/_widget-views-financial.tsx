'use client'

import { useTranslations } from 'next-intl'
import { Activity, AlertTriangle, ChartArea, Lightbulb, Percent, PiggyBank, Scale, Wallet, Zap } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { RatioCategory, RatioId, RatioResult } from '@/lib/analytics/financial-health'
import { useMoney } from '@/components/money-provider'
import { TrendChart } from '../analytics/_ui/charts'
import { HealthScore } from '../analytics/_ui/HealthScore'
import { GRADE_STYLE, toChartNumber, useRatioFormat } from '../analytics/_ui/format'
import { CardShell, ChartTile, MetricTile, UnavailableRow, type WidgetCardProps } from './_widget-tiles'
import type { FinancialSummary } from './_metrics-financial'

const HREF = '/analytics/financial-health'
type MetricTone = Parameters<typeof MetricTile>[0]['tone']
const GRADE_TONE: Record<string, MetricTone> = { A: 'emerald', B: 'teal', C: 'amber', D: 'orange', F: 'rose' }

const CATEGORY_WIDGETS: Record<string, RatioCategory> = {
  'ratios-profitability': 'profitability',
  'ratios-liquidity': 'liquidity',
  'ratios-solvency': 'solvency',
  'ratios-efficiency': 'efficiency',
  'ratios-operating': 'operating',
}

const RATIO_WIDGETS: Record<string, { id: RatioId; icon: React.ReactNode }> = {
  'kpi-ratio-current': { id: 'current_ratio', icon: <Scale size={15} /> },
  'kpi-ratio-quick': { id: 'quick_ratio', icon: <Scale size={15} /> },
  'kpi-working-capital': { id: 'working_capital', icon: <Wallet size={15} /> },
  'kpi-ratio-debt-equity': { id: 'debt_to_equity', icon: <Scale size={15} /> },
  'kpi-ratio-interest-coverage': { id: 'interest_coverage', icon: <Scale size={15} /> },
  'kpi-ratio-roe': { id: 'roe', icon: <Percent size={15} /> },
  'kpi-ratio-roic': { id: 'roic', icon: <Percent size={15} /> },
  'kpi-ratio-operating-margin': { id: 'operating_margin', icon: <Percent size={15} /> },
  'kpi-ratio-net-margin': { id: 'net_margin', icon: <Percent size={15} /> },
}

/**
 * Render cases for the dashboard widgets extracted from Financial Health.
 * WidgetCard delegates every widget whose registry entry names this source here.
 */
export function FinancialWidgetCard({ widgetId, data }: WidgetCardProps): React.ReactNode {
  const t = useTranslations('dashboard')
  switch (widgetId) {
    case 'ratios-profitability':
    case 'ratios-liquidity':
    case 'ratios-solvency':
    case 'ratios-efficiency':
    case 'ratios-operating':
      return <RatioList widgetId={widgetId} summary={data.financialSummary} />
    case 'kpi-ratio-current':
    case 'kpi-ratio-quick':
    case 'kpi-working-capital':
    case 'kpi-ratio-debt-equity':
    case 'kpi-ratio-interest-coverage':
    case 'kpi-ratio-roe':
    case 'kpi-ratio-roic':
    case 'kpi-ratio-operating-margin':
    case 'kpi-ratio-net-margin':
      return <RatioTile widgetId={widgetId} summary={data.financialSummary} />
    case 'health-score':
      return <HealthScoreCard summary={data.financialSummary} />
    case 'list-health-insights': {
      const insights = data.financialInsights
      return (
        <CardShell title={t('widgets.healthInsights')} icon={<Lightbulb size={14} />} href={HREF}>
          {insights === null ? <UnavailableRow reason={t('analytics.loading')} /> : !insights.available ? (
            <UnavailableRow reason={insights.reason} />
          ) : insights.value.items.length === 0 ? (
            <UnavailableRow reason={t('analytics.nothingFlagged')} />
          ) : (
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              {insights.value.items.map((item, i) => {
                const Icon = item.severity === 'issue' ? AlertTriangle : item.severity === 'rec' ? Lightbulb : Zap
                const tone = item.severity === 'issue' ? 'text-red-500' : item.severity === 'rec' ? 'text-emerald-500' : 'text-amber-500'
                return (
                  <li key={i} className="flex gap-2.5 px-4 py-2.5">
                    <Icon size={14} className={cn('mt-0.5 shrink-0', tone)} />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">{item.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{item.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardShell>
      )
    }
    case 'chart-revenue-trend':
    case 'chart-margin-trend':
      return <TrendTile widgetId={widgetId} trend={data.financialTrend} />
    case 'budget-variance':
      return <BudgetCard budget={data.budgetSummary} />
    default:
      return null
  }
}

function findRatio(summary: FinancialSummary, id: RatioId): RatioResult | undefined {
  return Object.values(summary.ratios).flat().find((r) => r.id === id)
}

function RatioTile({ widgetId, summary }: { widgetId: string; summary: WidgetCardProps['data']['financialSummary'] }) {
  const t = useTranslations('dashboard')
  const tr = useTranslations('analytics.financialHealth')
  const format = useRatioFormat()
  const { id, icon } = RATIO_WIDGETS[widgetId]!
  const label = tr(`ratios.${id}.label`)
  if (summary === null || !summary.available) {
    return <MetricTile icon={icon} label={label} value="—" href={HREF} tone="slate" hint={summary?.available === false ? summary.reason : undefined} />
  }
  const r = findRatio(summary.value, id)
  if (!r || r.value === null) {
    return <MetricTile icon={icon} label={label} value="—" href={HREF} tone="slate" hint={r?.unavailable ?? undefined} />
  }
  const target = format(r.benchmark, r.format)
  const parts = [
    r.grade ? t('analytics.grade', { grade: r.grade }) : null,
    target ? t('analytics.target', { target }) : null,
    summary.value.periodLabel,
  ].filter(Boolean)
  return (
    <MetricTile
      icon={icon}
      label={label}
      value={format(r.value, r.format, false) ?? '—'}
      href={HREF}
      tone={r.grade ? GRADE_TONE[r.grade]! : 'slate'}
      hint={parts.join(' · ')}
    />
  )
}

function RatioList({ widgetId, summary }: { widgetId: string; summary: WidgetCardProps['data']['financialSummary'] }) {
  const t = useTranslations('dashboard')
  const tr = useTranslations('analytics.financialHealth')
  const format = useRatioFormat()
  const category = CATEGORY_WIDGETS[widgetId]!
  const title = t(`widgets.ratios${category[0]!.toUpperCase()}${category.slice(1)}`)
  return (
    <CardShell title={title} icon={<Activity size={14} />} href={HREF}>
      {summary === null ? <UnavailableRow reason={t('analytics.loading')} /> : !summary.available ? (
        <UnavailableRow reason={summary.reason} />
      ) : (
        <>
          <p className="px-4 pt-2 text-[11px] text-slate-400 dark:text-slate-500">{summary.value.periodLabel}</p>
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {summary.value.ratios[category].map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-700 dark:text-slate-200">{tr(`ratios.${r.id}.label`)}</span>
                  {r.value === null ? (
                    <span className="block truncate text-[11px] text-amber-600 dark:text-amber-400">{r.unavailable}</span>
                  ) : r.benchmark !== null ? (
                    <span className="block text-[11px] text-slate-400 dark:text-slate-500">{t('analytics.target', { target: format(r.benchmark, r.format) ?? '' })}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900 tabular-nums dark:text-slate-100">{format(r.value, r.format) ?? '—'}</span>
                  {r.grade ? <span className={cn('w-6 rounded py-0.5 text-center text-[11px] font-bold', GRADE_STYLE[r.grade])}>{r.grade}</span> : <span className="w-6" />}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </CardShell>
  )
}

function HealthScoreCard({ summary }: { summary: WidgetCardProps['data']['financialSummary'] }) {
  const t = useTranslations('dashboard')
  const tf = useTranslations('analytics.financialHealth')
  return (
    <CardShell title={t('widgets.healthScore')} icon={<Activity size={14} />} href={HREF}>
      {summary === null ? <UnavailableRow reason={t('analytics.loading')} /> : !summary.available ? (
        <UnavailableRow reason={summary.reason} />
      ) : summary.value.overallScore === null ? (
        <UnavailableRow reason={tf('score.notScored')} />
      ) : (
        <div className="px-4 py-3">
          <HealthScore
            score={summary.value.overallScore}
            scoreLabel={tf(`score.${summary.value.scoreLabel}`)}
            overallLabel={tf('score.overall')}
            categories={summary.value.categoryScores
              .filter((c): c is { key: RatioCategory; score: number } => c.score !== null)
              .map((c) => ({ label: tf(`categories.${c.key}`), score: c.score }))}
          />
        </div>
      )}
    </CardShell>
  )
}

function TrendTile({ widgetId, trend }: { widgetId: string; trend: WidgetCardProps['data']['financialTrend'] }) {
  const t = useTranslations('dashboard')
  const tf = useTranslations('analytics.financialHealth')
  const { money } = useMoney()
  const margin = widgetId === 'chart-margin-trend'
  const title = t(margin ? 'widgets.marginTrend' : 'widgets.revenueTrend')
  if (trend === null || !trend.available || trend.value.points.length < 2) {
    return (
      <CardShell title={title} icon={<ChartArea size={14} />} href={HREF}>
        <UnavailableRow reason={trend?.available === false ? trend.reason : t('analytics.notEnoughHistory')} />
      </CardShell>
    )
  }
  const points = trend.value.points
  const last = points[points.length - 1]!
  return (
    <ChartTile
      title={title}
      icon={<ChartArea size={14} />}
      href={HREF}
      headline={margin ? undefined : money(last.revenue, { maximumFractionDigits: 0 })}
      context={t('analytics.trailingMonths', { count: points.length })}
    >
      {margin ? (
        <TrendChart
          labels={points.map((p) => p.label)}
          height="fill"
          pctAxis
          series={[
            { name: tf('pnl.grossProfit'), data: points.map((p) => p.grossMarginPct), color: '#0d9488', pct: true },
            { name: tf('pnl.operatingIncome'), data: points.map((p) => p.operatingMarginPct), color: '#f59e0b', pct: true },
          ]}
        />
      ) : (
        <TrendChart
          labels={points.map((p) => p.label)}
          height="fill"
          area
          series={[
            { name: tf('pnl.revenue'), data: points.map((p) => toChartNumber(p.revenue)), color: '#0d9488' },
            { name: tf('pnl.grossProfit'), data: points.map((p) => toChartNumber(p.grossProfit)), color: '#6366f1' },
            { name: tf('pnl.operatingIncome'), data: points.map((p) => toChartNumber(p.operatingIncome)), color: '#f59e0b' },
          ]}
        />
      )}
    </ChartTile>
  )
}

function BudgetCard({ budget }: { budget: WidgetCardProps['data']['budgetSummary'] }) {
  const t = useTranslations('dashboard')
  const { money } = useMoney()
  return (
    <CardShell title={t('widgets.budgetVariance')} icon={<PiggyBank size={14} />} href={HREF}>
      {budget === null ? <UnavailableRow reason={t('analytics.loading')} /> : !budget.available ? (
        <UnavailableRow reason={budget.reason} />
      ) : budget.value === null ? (
        <UnavailableRow reason={t('analytics.noBudget')} />
      ) : (
        <div className="px-4 py-3">
          <p className="text-[11px] text-slate-400 dark:text-slate-500">{budget.value.scenarioName} · {budget.value.periodLabel}</p>
          <dl className="mt-2 grid grid-cols-3 gap-2">
            {(['budget', 'actual', 'variance'] as const).map((k) => (
              <div key={k}>
                <dt className="text-[11px] text-slate-500 dark:text-slate-400">{t(`analytics.${k}`)}</dt>
                <dd className="text-sm font-semibold text-slate-900 tabular-nums dark:text-slate-100">{money(budget.value![k], { maximumFractionDigits: 0 })}</dd>
              </div>
            ))}
          </dl>
          {budget.value.offTrack.length > 0 ? (
            <>
              <p className="mt-3 text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{t('analytics.offTrack')}</p>
              <ul className="mt-1 space-y-1">
                {budget.value.offTrack.map((row) => (
                  <li key={row.accountId} className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-slate-600 dark:text-slate-300">{row.name}</span>
                    <span className={cn('tabular-nums', row.favorable ? 'text-emerald-600' : 'text-red-600')}>{money(row.variance, { maximumFractionDigits: 0 })}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </CardShell>
  )
}
