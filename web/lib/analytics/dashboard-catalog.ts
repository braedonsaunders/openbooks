import { permissionSetCovers } from '../permissions'

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
  // Whole-company forensics: cross-entity baselines, identity matches and
  // retained audit snapshots cannot be partially shown, so the dashboard needs
  // the audit grant AND unrestricted subsidiary scope.
  { slug: 'sentinel', group: 'risk', icon: 'ShieldAlert', titleKey: 'sentinel', permission: 'admin.audit.read', industries: [], unrestricted: true },
]
/**
 * The grant half of a dashboard's availability, as data: reports.read, the
 * dashboard's own permission and its subsidiary-scope rule. Returns the
 * first missing requirement's name, or null when the grants suffice. Pure,
 * so every boundary — the hub, the preview API, the dashboard pages, the
 * Sentinel routes and the home-dashboard widgets extracted from a dashboard —
 * applies the one rule. The Company Features half is asynchronous and lives
 * in dashboard-access.ts.
 */
export function analyticsDashboardDenied(
  grants: { permissions: ReadonlySet<string>; allowedSubsidiaryIds: ReadonlySet<string> | null },
  dashboard: AnalyticsDashboardDefinition,
): string | null {
  if (!permissionSetCovers(grants.permissions, 'reports.read')) return 'reports.read'
  if (dashboard.permission && !permissionSetCovers(grants.permissions, dashboard.permission)) return dashboard.permission
  if (dashboard.unrestricted && grants.allowedSubsidiaryIds !== null) return 'unrestricted subsidiary access'
  return null
}

export const ANALYTICS_GROUPS: readonly AnalyticsGroupKey[] = ['finance', 'cash', 'customers', 'projects', 'supply', 'risk']
export const ANALYTICS_DASHBOARD_MAP = Object.fromEntries(ANALYTICS_DASHBOARDS.map((d) => [d.slug, d])) as Record<string, AnalyticsDashboardDefinition | undefined>
export type AnalyticsPreviewChart =
  | { kind: 'sparkline'; label: string; points: number[]; from: string; to: string }
  | { kind: 'donut'; label: string; slices: { name: string; value: number }[] }
  | { kind: 'gauge'; label: string; value: number; goodWhenHigh: boolean }
export interface AnalyticsPreview { chart?: AnalyticsPreviewChart; periodLabel: string; metrics: { label: string; value: string }[]; observedAt: string; notice?: string }
