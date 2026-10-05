import 'server-only'
import type { DashboardWidgetContext } from './_metrics-context'

/**
 * Dashboard widget readers for utilization and overhead absorption (Utilization, True Cost).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 */
export type ProjectWidgetMetrics = Record<never, never>

export const EMPTY_PROJECT_WIDGET_METRICS: ProjectWidgetMetrics = {}

export async function loadProjectWidgetMetrics(
  _ctx: DashboardWidgetContext,
  _need: (...fields: (keyof ProjectWidgetMetrics)[]) => boolean,
): Promise<Partial<ProjectWidgetMetrics>> {
  return {}
}
