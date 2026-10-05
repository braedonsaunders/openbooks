import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import { sentinelRiskSummary } from '@/lib/analytics/sentinel-data'
import { sentinelStrings } from '@/lib/analytics/sentinel-strings'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'

/**
 * Dashboard widget readers for forensic risk signals (Sentinel).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 *
 * Both tiles read the shared sentinelRiskSummary — the same figures the
 * Sentinel dashboard shows — over the dashboards' opening period, so a
 * widget and its dashboard can never disagree.
 */
export type ForensicRiskTile = {
  /** Overall forensic risk score, 0-100, exactly as Sentinel shows it. */
  score: number
  flagged: number
  /** Exact presentation-currency total at risk. */
  value: string
  currency: string
  periodLabel: string
}

export type DuplicatePaymentsTile = {
  groups: number
  /** Exact presentation-currency duplicate value at risk. */
  value: string
  currency: string
  periodLabel: string
}

export type RiskWidgetMetrics = {
  forensicRisk: ForensicRiskTile | null
  duplicatePayments: WidgetValue<DuplicatePaymentsTile> | null
}

export const EMPTY_RISK_WIDGET_METRICS: RiskWidgetMetrics = {
  forensicRisk: null,
  duplicatePayments: null,
}

export async function loadRiskWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof RiskWidgetMetrics)[]) => boolean,
): Promise<Partial<RiskWidgetMetrics>> {
  if (!need('forensicRisk', 'duplicatePayments')) return {}
  const period = await ctx.period()
  // Forensic sentences resolve through the analytics catalog in the request
  // locale — the same locale the dashboard statements use.
  const [tc, locale] = await Promise.all([getTranslations('analytics'), getLocale()])
  const strings = sentinelStrings((key, values) => tc(key, values), locale)
  const summary = await sentinelRiskSummary(
    ctx.orgId,
    { from: period.from, to: period.to, label: period.label },
    ctx.authz,
    strings,
  )
  const out: Partial<RiskWidgetMetrics> = {}
  if (need('forensicRisk')) {
    out.forensicRisk = {
      score: summary.overallRiskScore,
      flagged: summary.flaggedCount,
      value: summary.totalAtRisk,
      currency: summary.presentationCurrency,
      periodLabel: summary.periodLabel,
    }
  }
  if (need('duplicatePayments')) {
    const reason = summary.duplicateUnavailableReason
    out.duplicatePayments = reason === null
      ? {
        available: true,
        value: {
          groups: summary.duplicateCount,
          value: summary.duplicateValue,
          currency: summary.presentationCurrency,
          periodLabel: summary.periodLabel,
        },
      }
      : { available: false, reason }
  }
  return out
}
