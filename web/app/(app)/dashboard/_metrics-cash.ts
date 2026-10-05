import 'server-only'
import type { DashboardWidgetContext } from './_metrics-context'

/**
 * Dashboard widget readers for cash conversion, cash pressure and the cash forecast (Cash Flow).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 */
export type CashWidgetMetrics = Record<never, never>

export const EMPTY_CASH_WIDGET_METRICS: CashWidgetMetrics = {}

export async function loadCashWidgetMetrics(
  _ctx: DashboardWidgetContext,
  _need: (...fields: (keyof CashWidgetMetrics)[]) => boolean,
): Promise<Partial<CashWidgetMetrics>> {
  return {}
}
