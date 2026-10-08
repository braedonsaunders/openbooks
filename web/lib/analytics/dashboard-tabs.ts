/** Native dashboard sections, shared by the data boundary and tab controls. */
export const ANALYTICS_TABS = {
  'receivables-intelligence': ['customers', 'behavior', 'recovery', 'collections', 'credit', 'configuration'],
  'financial-health': ['overview', 'margin', 'items', 'segments', 'forecast', 'scenarios', 'budget', 'drivers', 'ratios', 'configuration'],
  cashflow: ['overview', 'category'],
  'true-cost': ['absorption', 'selling'],
  utilization: ['overview', 'intelligence', 'departments', 'items', 'titles', 'employees', 'config'],
  'customer-intelligence': ['overview', 'health', 'segmentation', 'lifetime', 'churn', 'growth', 'profitability', 'configuration'],
  'vendor-performance': ['overview', 'payment', 'scorecard', 'matrix', 'vendors', 'configuration'],
  'spend-velocity': ['overview', 'velocity', 'detectors', 'accounts', 'trends', 'config'],
  sentinel: ['overview', 'benford', 'analysis', 'detection', 'vendors', 'audit', 'config'],
} as const
export type AnalyticsSlug = keyof typeof ANALYTICS_TABS

export function analyticsTab(slug: AnalyticsSlug, requested?: string): string {
  const tabs: readonly string[] = ANALYTICS_TABS[slug]
  return requested && tabs.includes(requested) ? requested : tabs[0]!
}
