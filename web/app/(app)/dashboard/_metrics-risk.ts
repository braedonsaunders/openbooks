import 'server-only'
import type { DashboardWidgetContext } from './_metrics-context'

/**
 * Dashboard widget readers for forensic risk signals (Sentinel).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 */
export type RiskWidgetMetrics = Record<never, never>

export const EMPTY_RISK_WIDGET_METRICS: RiskWidgetMetrics = {}

export async function loadRiskWidgetMetrics(
  _ctx: DashboardWidgetContext,
  _need: (...fields: (keyof RiskWidgetMetrics)[]) => boolean,
): Promise<Partial<RiskWidgetMetrics>> {
  return {}
}
