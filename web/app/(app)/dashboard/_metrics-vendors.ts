import 'server-only'
import type { DashboardWidgetContext } from './_metrics-context'

/**
 * Dashboard widget readers for supplier concentration, payment performance and spend velocity (Vendor Performance, Spend Velocity).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 */
export type VendorWidgetMetrics = Record<never, never>

export const EMPTY_VENDOR_WIDGET_METRICS: VendorWidgetMetrics = {}

export async function loadVendorWidgetMetrics(
  _ctx: DashboardWidgetContext,
  _need: (...fields: (keyof VendorWidgetMetrics)[]) => boolean,
): Promise<Partial<VendorWidgetMetrics>> {
  return {}
}
