import 'server-only'
import { MissingExchangeRateError } from '@/lib/fx-presentation'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'

/**
 * Dashboard widget readers for cash conversion, cash pressure and the cash forecast (Cash Flow).
 *
 * Every figure is the Cash Flow position's own for the org's configured
 * horizon, scope and AP capacity settings: one cashPosition call per request
 * (memoized on the widget context) feeds the runway tile and every widget
 * below, so a tile and its dashboard can never disagree. Each field is read
 * only when a visible widget lists it in WIDGET_METRIC_FIELDS (_metrics.ts):
 * a denied or absent widget's reader never runs.
 */

export type CashLowestPoint = {
  amount: string
  /** Week-start ISO of the week the lowest projected cash occurs in. */
  week: string
  status: 'healthy' | 'caution' | 'critical'
  horizonWeeks: number
}

export type CashWidgetMetrics = {
  cashLowest: WidgetValue<CashLowestPoint> | null
}

export const EMPTY_CASH_WIDGET_METRICS: CashWidgetMetrics = {
  cashLowest: null,
}

export async function loadCashWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof CashWidgetMetrics)[]) => boolean,
): Promise<Partial<CashWidgetMetrics>> {
  if (!need('cashLowest')) return {}
  const read = ctx.cashPosition
  if (!read) return {}
  let position
  try {
    position = await read()
  } catch (error: unknown) {
    // A missing exchange rate refuses per widget with its message (the
    // runway tile answers the same condition with no-data); anything else
    // still throws.
    if (error instanceof MissingExchangeRateError) {
      return { cashLowest: { available: false, reason: error.message } }
    }
    throw error
  }
  return {
    cashLowest: {
      available: true,
      value: {
        amount: position.lowestCash,
        week: position.lowestWeek,
        status: position.runwayStatus,
        horizonWeeks: position.horizonWeeks,
      },
    },
  }
}
