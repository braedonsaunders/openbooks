import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import { budgetVariance, healthSummaryData, type Insight } from '@/lib/analytics/health-data'
import { healthStrings } from '@/lib/analytics/health-strings'
import type { CategoryScore, RatioCategory, RatioResult, ScoreLabel } from '@/lib/analytics/financial-health'
import { ReportCurrencyBasisError } from '@/lib/reports/currency-basis'
import { MissingExchangeRateError } from '@/lib/fx-presentation'
import { isFeatureEnabled } from '@/lib/features'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'

/**
 * Dashboard widget readers for financial ratios, the health score, the
 * findings, performance trends and budget variance (Financial Health).
 *
 * Every figure is the Financial Health engine's own for the period the
 * dashboard opens on: one engine run per request feeds every ratio, score,
 * finding and trend widget, so a tile and its dashboard can never disagree.
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts).
 */
export type FinancialSummary = {
  periodLabel: string
  currency: string
  ratios: Record<RatioCategory, RatioResult[]>
  overallScore: number | null
  scoreLabel: ScoreLabel | null
  categoryScores: CategoryScore[]
}

export type FinancialTrendPoint = {
  label: string
  revenue: string
  grossProfit: string
  operatingIncome: string
  /** Display ratios (dimensionless), already computed by the engine's monthly series. */
  grossMarginPct: number
  operatingMarginPct: number
}

export type BudgetSummary = {
  periodLabel: string
  scenarioName: string
  budget: string
  actual: string
  variance: string
  /** Accounts whose variance is unfavorable beyond the watch band. */
  offTrack: { accountId: string; name: string; variance: string; favorable: boolean }[]
}

export type FinancialWidgetMetrics = {
  financialSummary: WidgetValue<FinancialSummary> | null
  financialInsights: WidgetValue<{ periodLabel: string; items: Insight[] }> | null
  financialTrend: WidgetValue<{ periodLabel: string; points: FinancialTrendPoint[] }> | null
  budgetSummary: WidgetValue<BudgetSummary | null> | null
}

export const EMPTY_FINANCIAL_WIDGET_METRICS: FinancialWidgetMetrics = {
  financialSummary: null,
  financialInsights: null,
  financialTrend: null,
  budgetSummary: null,
}

/** The declared refusals a scope can hit, surfaced on the tile with their message. */
function refusal(error: unknown): { available: false; reason: string } {
  if (error instanceof ReportCurrencyBasisError || error instanceof MissingExchangeRateError) {
    return { available: false, reason: error.message }
  }
  throw error
}

export async function loadFinancialWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof FinancialWidgetMetrics)[]) => boolean,
): Promise<Partial<FinancialWidgetMetrics>> {
  const wantHealth = need('financialSummary', 'financialInsights', 'financialTrend')
  const wantBudget = need('budgetSummary')
  if (!wantHealth && !wantBudget) return {}
  const period = await ctx.period()
  const out: Partial<FinancialWidgetMetrics> = {}

  const [health, budget] = await Promise.all([
    wantHealth
      ? (async () => {
          const [t, locale] = await Promise.all([getTranslations('analytics'), getLocale()])
          const strings = healthStrings((key, values) => t(key, values), locale)
          return healthSummaryData(period, ctx.orgId, ctx.allowedSubsidiaryIds, strings)
        })().then((data) => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error }))
      : null,
    wantBudget
      ? (async () => (await isFeatureEnabled(ctx.orgId, 'budgets')) ? budgetVariance(ctx.orgId, period.from, period.to, ctx.allowedSubsidiaryIds) : null)()
          .then((data) => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error }))
      : null,
  ])

  if (health) {
    if (!health.ok) {
      const failed = refusal(health.error)
      if (need('financialSummary')) out.financialSummary = failed
      if (need('financialInsights')) out.financialInsights = failed
      if (need('financialTrend')) out.financialTrend = failed
    } else {
      const h = health.data
      if (need('financialSummary')) {
        out.financialSummary = {
          available: true,
          value: {
            periodLabel: period.label,
            currency: h.currency,
            ratios: h.ratios,
            overallScore: h.overallScore,
            scoreLabel: h.scoreLabel,
            categoryScores: h.categoryScores,
          },
        }
      }
      if (need('financialInsights')) out.financialInsights = { available: true, value: { periodLabel: period.label, items: h.insights } }
      if (need('financialTrend')) {
        out.financialTrend = {
          available: true,
          value: {
            periodLabel: period.label,
            points: h.monthly.map((m) => ({
              label: m.label,
              revenue: m.revenue,
              grossProfit: m.grossProfit,
              operatingIncome: m.operatingIncome,
              grossMarginPct: m.grossMarginPct,
              operatingMarginPct: m.operatingMarginPct,
            })),
          },
        }
      }
    }
  }

  if (budget) {
    if (!budget.ok) out.budgetSummary = refusal(budget.error)
    else {
      const b = budget.data
      out.budgetSummary = {
        available: true,
        value: b === null || b.scenario === null
          ? null
          : {
              periodLabel: period.label,
              scenarioName: b.scenario.name,
              budget: b.totals.budget,
              actual: b.totals.actual,
              variance: b.totals.variance,
              offTrack: b.rows
                .filter((r) => r.status === 'over' || r.status === 'under')
                .slice(0, 5)
                .map((r) => ({ accountId: r.accountId, name: r.name, variance: r.variance, favorable: r.favorable })),
            },
      }
    }
  }
  return out
}
