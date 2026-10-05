import 'server-only'
import type { DashboardWidgetContext } from './_metrics-context'

/**
 * Dashboard widget readers for financial ratios, the health score, budget variance and performance trends (Financial Health).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 */
export type FinancialWidgetMetrics = Record<never, never>

export const EMPTY_FINANCIAL_WIDGET_METRICS: FinancialWidgetMetrics = {}

export async function loadFinancialWidgetMetrics(
  _ctx: DashboardWidgetContext,
  _need: (...fields: (keyof FinancialWidgetMetrics)[]) => boolean,
): Promise<Partial<FinancialWidgetMetrics>> {
  return {}
}
