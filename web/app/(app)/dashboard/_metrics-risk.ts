import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import { MissingExchangeRateError } from '@/lib/fx-presentation'
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
  /** Translated names of scoring sources skipped for lack of configuration. */
  excluded: string[]
}

export type DuplicatePaymentsTile = {
  groups: number
  /** Exact presentation-currency duplicate value at risk. */
  value: string
  currency: string
  periodLabel: string
}

export type RiskWidgetMetrics = {
  forensicRisk: WidgetValue<ForensicRiskTile> | null
  duplicatePayments: WidgetValue<DuplicatePaymentsTile> | null
}

export const EMPTY_RISK_WIDGET_METRICS: RiskWidgetMetrics = {
  forensicRisk: null,
  duplicatePayments: null,
}

/** The declared refusals a scope can hit, surfaced on the tile with their message. */
function refusal(error: unknown): { available: false; reason: string } {
  if (error instanceof MissingExchangeRateError) {
    return { available: false, reason: error.message }
  }
  throw error
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
  // A scope without exchange coverage refuses instead of failing the whole
  // dashboard Promise.all — the tile carries the refusal like any other.
  const summary = await (async () => sentinelRiskSummary(
    ctx.orgId,
    { from: period.from, to: period.to, label: period.label },
    ctx.authz,
    strings,
  ))().then((data) => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error }))
  const out: Partial<RiskWidgetMetrics> = {}
  if (need('forensicRisk')) {
    out.forensicRisk = !summary.ok
      ? refusal(summary.error)
      : {
        available: true,
        value: {
          score: summary.data.overallRiskScore,
          flagged: summary.data.flaggedCount,
          value: summary.data.totalAtRisk,
          currency: summary.data.presentationCurrency,
          periodLabel: summary.data.periodLabel,
          excluded: summary.data.excludedDetectors,
        },
      }
  }
  if (need('duplicatePayments')) {
    if (!summary.ok) {
      out.duplicatePayments = refusal(summary.error)
    } else {
      const reason = summary.data.duplicateUnavailableReason
      out.duplicatePayments = reason === null
        ? {
          available: true,
          value: {
            groups: summary.data.duplicateCount,
            value: summary.data.duplicateValue,
            currency: summary.data.presentationCurrency,
            periodLabel: summary.data.periodLabel,
          },
        }
        : { available: false, reason }
    }
  }
  return out
}
