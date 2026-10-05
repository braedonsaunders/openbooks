import 'server-only'
import type { DashboardWidgetContext } from './_metrics-context'

/**
 * Dashboard widget readers for customer concentration and retention risk (Customer Intelligence).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 */
export type CustomerWidgetMetrics = Record<never, never>

export const EMPTY_CUSTOMER_WIDGET_METRICS: CustomerWidgetMetrics = {}

export async function loadCustomerWidgetMetrics(
  _ctx: DashboardWidgetContext,
  _need: (...fields: (keyof CustomerWidgetMetrics)[]) => boolean,
): Promise<Partial<CustomerWidgetMetrics>> {
  return {}
}
