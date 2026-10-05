/** Analytics availability follows dashboard permissions and Company Features.
 * Industry assignments describe recommended uses; they never grant access. */
export type AnalyticsGroupKey = 'finance' | 'cash' | 'customers' | 'projects' | 'supply' | 'risk'
export interface AnalyticsDashboardDefinition {
  slug: string
  group: AnalyticsGroupKey
  icon: string
  titleKey: string
  permission?: string
  feature?: string
  industries: string[]
  unrestricted?: boolean
}
const services = ['professional_services', 'engineering_architecture', 'accounting_firm', 'construction_contractor']
export const ANALYTICS_DASHBOARDS: readonly AnalyticsDashboardDefinition[] = [
  { slug: 'financial-health', group: 'finance', icon: 'Activity', titleKey: 'financialHealth', industries: [] },
  { slug: 'cashflow', group: 'cash', icon: 'Wallet', titleKey: 'cashflow', industries: [] },
  { slug: 'true-cost', group: 'projects', icon: 'Coins', titleKey: 'trueCost', feature: 'projects', industries: services },
  { slug: 'utilization', group: 'projects', icon: 'Clock', titleKey: 'utilization', feature: 'timeTracking', industries: services },
  { slug: 'customer-intelligence', group: 'customers', icon: 'Users', titleKey: 'customer', industries: [] },
  { slug: 'vendor-performance', group: 'supply', icon: 'Truck', titleKey: 'vendor', industries: [] },
  { slug: 'spend-velocity', group: 'risk', icon: 'Zap', titleKey: 'spendVelocity', industries: [] },
  { slug: 'sentinel', group: 'risk', icon: 'ShieldAlert', titleKey: 'sentinel', industries: [], unrestricted: true },
]
export const ANALYTICS_GROUPS: readonly AnalyticsGroupKey[] = ['finance', 'cash', 'customers', 'projects', 'supply', 'risk']
export const ANALYTICS_DASHBOARD_MAP = Object.fromEntries(ANALYTICS_DASHBOARDS.map((d) => [d.slug, d])) as Record<string, AnalyticsDashboardDefinition | undefined>
export type AnalyticsPreviewChart =
  | { kind: 'sparkline'; label: string; points: number[]; from: string; to: string }
  | { kind: 'donut'; label: string; slices: { name: string; value: number }[] }
  | { kind: 'gauge'; label: string; value: number; goodWhenHigh: boolean }
export interface AnalyticsPreview { chart?: AnalyticsPreviewChart; periodLabel: string; metrics: { label: string; value: string }[]; observedAt: string; notice?: string }
