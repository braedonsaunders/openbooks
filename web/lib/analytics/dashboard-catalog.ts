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
  /** Further grants the dashboard's evidence needs in full, beyond its permission. */
  alsoRequires?: readonly string[]
  feature?: string
  industries: string[]
  unrestricted?: boolean
}
const services = ['professional_services', 'engineering_architecture', 'accounting_firm', 'construction_contractor']
// Every dashboard names the domain grant its data comes from, beyond
// reports.read: the ledger for financial health, banking for cash flow, the
// subledger or module for the rest — the same scoping the report statements use.
export const ANALYTICS_DASHBOARDS: readonly AnalyticsDashboardDefinition[] = [
  { slug: 'receivables-intelligence', group: 'cash', icon: 'Banknote', titleKey: 'receivables', permission: 'ar.read', industries: [] },
  { slug: 'financial-health', group: 'finance', icon: 'Activity', titleKey: 'financialHealth', permission: 'gl.read', industries: [] },
  { slug: 'cashflow', group: 'cash', icon: 'Wallet', titleKey: 'cashflow', permission: 'banking.read', industries: [] },
  { slug: 'true-cost', group: 'projects', icon: 'Coins', titleKey: 'trueCost', feature: 'projects', permission: 'projects.read', industries: services },
  { slug: 'utilization', group: 'projects', icon: 'Clock', titleKey: 'utilization', feature: 'timeTracking', permission: 'time.read', industries: services },
  { slug: 'customer-intelligence', group: 'customers', icon: 'Users', titleKey: 'customer', permission: 'ar.read', industries: [] },
  { slug: 'vendor-performance', group: 'supply', icon: 'Truck', titleKey: 'vendor', permission: 'ap.read', industries: [] },
  { slug: 'spend-velocity', group: 'risk', icon: 'Zap', titleKey: 'spendVelocity', permission: 'ap.read', industries: [] },
  // Whole-company forensics: cross-entity baselines, identity matches and
  // retained audit snapshots cannot be partially shown, so the dashboard needs
  // the audit grant AND unrestricted subsidiary scope. Its spend evidence
  // includes every employee's expense reports, so it needs org-wide expense
  // read as well rather than silently dropping them.
  { slug: 'sentinel', group: 'risk', icon: 'ShieldAlert', titleKey: 'sentinel', permission: 'admin.audit.read', alsoRequires: ['expenses.read'], industries: [], unrestricted: true },
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
  for (const permission of dashboard.alsoRequires ?? []) {
    if (!permissionSetCovers(grants.permissions, permission)) return permission
  }
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

/**
 * A home-dashboard spotlight: a projection of one Analytics dashboard's own
 * default-view read. Figures arrive formatted in the viewer's locale and the
 * payload's currency; chart series are chart numbers crossed at the
 * projection boundary. Nothing here is computed again from source rows.
 */
export type SpotlightTone = 'positive' | 'caution' | 'negative' | 'neutral'
export type SpotlightFormat = 'money' | 'count' | 'percent'
export interface SpotlightFigure { label: string; value: string; detail?: string; tone?: SpotlightTone }
/** Series roles map to the shared analytics palette on the client; `signed` bars color each point by its sign. */
export type SpotlightSeriesRole = 'primary' | 'secondary' | 'positive' | 'negative' | 'caution' | 'muted' | 'signed'
/** Percent series carry values on the 0–100 scale. */
export interface SpotlightSeries { name: string; values: (number | null)[]; style: 'line' | 'area' | 'bar' | 'dashed'; role?: SpotlightSeriesRole }
export interface SpotlightRankRow { name: string; value: string; /** Bar length on the 0–1 scale of the panel's largest row. */ share: number; detail?: string; tone?: SpotlightTone }
export type SpotlightPanel =
  | { kind: 'trend'; title: string; labels: string[]; series: SpotlightSeries[]; format: SpotlightFormat; reference?: { value: number; label: string } }
  | { kind: 'donut'; title: string; format: SpotlightFormat; slices: { name: string; value: number; display: string; tone?: SpotlightTone; color?: string }[]; center?: SpotlightFigure }
  | { kind: 'gauge'; title: string; score: number; display: string; caption: string; goodWhenHigh: boolean; bands: { excellent: number; good: number; average: number } | null; breakdown?: { label: string; score: number | null }[] }
  | { kind: 'ranking'; title: string; rows: SpotlightRankRow[]; empty: string }
  | { kind: 'bridge'; title: string; steps: { label: string; amount: string; kind: 'start' | 'deduct' | 'subtotal' | 'total'; tone?: SpotlightTone }[] }
  | { kind: 'insights'; title: string; items: { tone: SpotlightTone; title: string; detail?: string }[]; empty: string }
export interface AnalyticsSpotlight {
  slug: string
  periodLabel: string
  observedAt: string
  /** Currency every money figure and series is stated in. */
  currency: string
  headline?: SpotlightFigure
  /** The first three ride the compact card; the expanded view shows all. */
  figures: SpotlightFigure[]
  /** The compact card's chart; the expanded view draws it at full width. */
  feature?: SpotlightPanel
  panels: SpotlightPanel[]
  /** A refusal or caveat from the owning dashboard, stated in its words. */
  notice?: string
}
