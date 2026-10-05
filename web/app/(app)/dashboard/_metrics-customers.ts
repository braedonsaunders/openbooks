import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  concentrationOf,
  customerSummaryData,
  type ConcentrationSummary,
} from '@/lib/analytics/customer-data'

/** The tile states the period beside the figure: a share without one misleads. */
type WithPeriod<T> = T & { period: string }
import { customerStrings as buildCustomerStrings } from '@/lib/analytics/customer-strings'
import { ReportCurrencyBasisError } from '@/lib/reports/currency-basis'
import { MissingExchangeRateError } from '@/lib/fx-presentation'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'

/**
 * Dashboard widget readers for Customer Intelligence: revenue
 * concentration, customers at churn risk, and the highest-risk list.
 *
 * Every figure is the Customer Intelligence preview's own for the period
 * the dashboard opens on: one narrow engine run per request — churn and
 * concentration off the same base the dashboard scores, without lifetime
 * cohorts, settlement detail, project profitability, DSO statistics or the
 * intelligence composite — feeds all three widgets, so a tile and its
 * dashboard can never disagree. Each field is read only when a visible
 * widget lists it in WIDGET_METRIC_FIELDS (_metrics.ts): a denied or
 * absent widget's reader never runs.
 */
export type AtRiskSummary = {
  /** Customers at or above the configured high-churn score. */
  count: number
  /** Their trailing revenue, an exact decimal string in presentation currency. */
  revenue: string
  /** The period label the revenue trails, rendered on the tile. */
  period: string
}

export type AtRiskCustomer = {
  id: string
  name: string
  churnLevel: 'critical' | 'high'
  /** Churn points, higher is riskier; the engine ranks by this. */
  churnScore: number
  /** Trailing revenue, an exact decimal string in presentation currency. */
  revenue: string
}

export type CustomerWidgetMetrics = {
  concentration: WidgetValue<WithPeriod<ConcentrationSummary>> | null
  atRisk: WidgetValue<AtRiskSummary> | null
  atRiskCustomers: WidgetValue<AtRiskCustomer[]> | null
}

export const EMPTY_CUSTOMER_WIDGET_METRICS: CustomerWidgetMetrics = {
  concentration: null,
  atRisk: null,
  atRiskCustomers: null,
}

type CustomerUnavailable = { available: false; reason: string }

/** The declared refusals a scope can hit, surfaced on the tile with their message. */
function refusal(error: unknown): CustomerUnavailable {
  if (error instanceof ReportCurrencyBasisError || error instanceof MissingExchangeRateError) {
    return { available: false, reason: error.message }
  }
  throw error
}

export async function loadCustomerWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof CustomerWidgetMetrics)[]) => boolean,
): Promise<Partial<CustomerWidgetMetrics>> {
  const wantConcentration = need('concentration')
  const wantAtRisk = need('atRisk')
  const wantList = need('atRiskCustomers')
  if (!wantConcentration && !wantAtRisk && !wantList) return {}
  const period = await ctx.period()
  const out: Partial<CustomerWidgetMetrics> = {}
  const fail = (failed: CustomerUnavailable) => {
    if (wantConcentration) out.concentration = failed
    if (wantAtRisk) out.atRisk = failed
    if (wantList) out.atRiskCustomers = failed
  }
  try {
    const [t, td, locale] = await Promise.all([
      getTranslations('analytics'),
      getTranslations('dashboard'),
      getLocale(),
    ])
    const strings = buildCustomerStrings((key, values) => t(key, values), locale)
    const data = await customerSummaryData(
      { from: period.from, to: period.to, label: period.label },
      ctx.orgId,
      ctx.allowedSubsidiaryIds,
      strings,
    )
    // A broken weight sum refuses by name: the figures are empty and every
    // widget says why, exactly as the dashboard does.
    if (data.weightsError) {
      fail({ available: false, reason: data.weightsError })
      return out
    }
    // No customers in scope means no concentration and nobody at risk — an
    // absent figure never renders as a zero that reads as a fact.
    if (data.kpis.totalCustomers === 0) {
      fail({ available: false, reason: td('metricContext.noData') })
      return out
    }
    if (wantConcentration) {
      // Shares divide by the period total: with no recognized revenue there
      // is no concentration to state, so the tile refuses instead of
      // rendering an HHI of 0 that reads as "perfectly diversified".
      const summary = concentrationOf(data.kpis)
      out.concentration = summary === null
        ? { available: false, reason: td('concentrationNoRevenue', { period: period.label }) }
        : { available: true, value: { ...summary, period: period.label } }
    }
    if (wantAtRisk) {
      out.atRisk = {
        available: true,
        value: { count: data.kpis.atRiskCount, revenue: data.kpis.atRiskRevenue, period: period.label },
      }
    }
    if (wantList) {
      // Ranked in the engine; the tile renders the order it is given.
      out.atRiskCustomers = {
        available: true,
        value: data.atRisk.map((r) => ({
          id: r.id,
          name: r.name,
          churnLevel: r.churnLevel,
          churnScore: r.churnScore,
          revenue: r.revenue,
        })),
      }
    }
  } catch (error) {
    fail(refusal(error))
  }
  return out
}
