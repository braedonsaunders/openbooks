/** Analytics availability follows native report permissions and Company Features.
 * Industry assignments describe recommended uses; they never grant access. */
export type AnalyticsGroupKey = 'finance' | 'cash' | 'customers' | 'projects' | 'people' | 'supply' | 'industry' | 'risk'
export interface AnalyticsDashboardDefinition {
  slug: string
  group: AnalyticsGroupKey
  icon: string
  titleKey?: string
  reportSlug?: string
  reportHref?: string
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
  { slug: 'receivables', group: 'cash', icon: 'Wallet', reportSlug: 'open-ar-by-customer', industries: [] },
  { slug: 'collections', group: 'cash', icon: 'Wallet', reportSlug: 'collection-recovery-rate', industries: [] },
  { slug: 'allocations', group: 'finance', icon: 'Coins', reportSlug: 'analytics-allocation-controls', industries: [] },
  { slug: 'sales-pipeline', group: 'customers', icon: 'Users', reportSlug: 'crm-pipeline-summary', industries: [] },
  { slug: 'sales-forecast', group: 'customers', icon: 'Activity', reportSlug: 'crm-forecast-by-owner', industries: [] },
  { slug: 'project-portfolio', group: 'projects', icon: 'Gauge', reportSlug: 'analytics-project-portfolio', industries: services },
  { slug: 'resource-capacity', group: 'projects', icon: 'Clock', titleKey: 'resourceCapacity', reportHref: '/reports/resourcing/capacity-demand', feature: 'resourcing', permission: 'resourcing.read', industries: services },
  { slug: 'workforce-capacity', group: 'people', icon: 'Users', reportSlug: 'analytics-workforce-capacity', industries: [] },
  { slug: 'payroll-cost', group: 'people', icon: 'Coins', reportSlug: 'payroll-cost-by-month', industries: [] },
  { slug: 'payroll-reconciliation', group: 'people', icon: 'ShieldAlert', reportSlug: 'analytics-payroll-reconciliation', industries: [] },
  { slug: 'asset-lifecycle', group: 'finance', icon: 'Gauge', reportSlug: 'analytics-asset-lifecycle', industries: [] },
  { slug: 'channel-margin', group: 'supply', icon: 'Truck', reportSlug: 'order-margin-by-channel', industries: ['wholesale_distribution', 'manufacturing'] },
  { slug: 'item-margin', group: 'supply', icon: 'Coins', reportSlug: 'order-margin-by-sku', industries: ['wholesale_distribution', 'manufacturing'] },
  { slug: 'stored-value', group: 'cash', icon: 'Wallet', reportSlug: 'stored-value-liability-roll-forward', industries: [] },
  { slug: 'subscription-growth', group: 'industry', icon: 'Activity', reportSlug: 'mrr-movements', industries: ['it_software_saas'] },
  { slug: 'revenue-lifecycle', group: 'industry', icon: 'Coins', reportSlug: 'bookings-billings-revenue', industries: ['it_software_saas'] },
  { slug: 'production', group: 'industry', icon: 'Gauge', reportSlug: 'analytics-production', industries: ['manufacturing'] },
  { slug: 'property-portfolio', group: 'industry', icon: 'Gauge', reportSlug: 'analytics-property-portfolio', industries: ['property_management'] },
  { slug: 'grant-portfolio', group: 'industry', icon: 'Coins', reportSlug: 'analytics-grant-portfolio', industries: ['nonprofit'], unrestricted: true },
]
export const ANALYTICS_GROUPS: readonly AnalyticsGroupKey[] = ['finance', 'cash', 'customers', 'projects', 'people', 'supply', 'industry', 'risk']
export const ANALYTICS_DASHBOARD_MAP = Object.fromEntries(ANALYTICS_DASHBOARDS.map((d) => [d.slug, d])) as Record<string, AnalyticsDashboardDefinition | undefined>
export type AnalyticsPreviewChart =
  | { kind: 'sparkline'; label: string; points: number[]; from: string; to: string }
  | { kind: 'donut'; label: string; slices: { name: string; value: number }[] }
  | { kind: 'gauge'; label: string; value: number; goodWhenHigh: boolean }
export interface AnalyticsPreview { chart?: AnalyticsPreviewChart; periodLabel: string; metrics: { label: string; value: string }[]; observedAt: string; notice?: string }
