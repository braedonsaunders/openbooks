import 'server-only'
import { requirePermission, ForbiddenError } from '../authz'
import { ANALYTICS_DASHBOARD_MAP, analyticsDashboardDenied } from './dashboard-catalog'
import { requireFeatureEnabled } from '../feature-gates'
import { analyticsTab, type AnalyticsSlug } from './dashboard-tabs'
import { analyticsCacheIdentity, cachedAnalyticsRead } from './preview-cache'
import { withAnalyticsRead } from './read-context'
import { analyticsSourceQuery, analyticsQueryString } from './query-params'

const loaders = {
  'financial-health': async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/financial-health/view')).loadFinancialHealth(sp),
  cashflow: async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/cashflow/view')).loadCashflow(sp),
  'true-cost': async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/true-cost/view')).loadTrueCost(sp),
  utilization: async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/utilization/view')).loadUtilization(sp),
  'customer-intelligence': async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/customer-intelligence/view')).loadCustomerIntelligence(sp),
  'vendor-performance': async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/vendor-performance/view')).loadVendorPerformance(sp),
  'spend-velocity': async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/spend-velocity/view')).loadSpendVelocity(sp),
  sentinel: async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/sentinel/view')).loadSentinel(sp),
}
type DashboardResult = Awaited<ReturnType<(typeof loaders)[AnalyticsSlug]>>

export async function readAnalyticsDashboard<S extends AnalyticsSlug>(slug: S, sp: Record<string, string | undefined>): Promise<Awaited<ReturnType<typeof loaders[S]>> & { observedAt: string }> {
  const authz = await requirePermission('reports.read')
  const definition = ANALYTICS_DASHBOARD_MAP[slug]!
  const denied = analyticsDashboardDenied(authz, definition)
  if (denied) throw new ForbiddenError(denied)
  if (definition.feature) await requireFeatureEnabled(authz.user.orgId, definition.feature)
  const tab = analyticsTab(slug, sp.tab)
  const query = analyticsSourceQuery(sp)
  const identity = await analyticsCacheIdentity(authz.user.orgId)
  const read = { authz, slug, tab, projection: 'tab' as const, ...identity, observedAt: Date.now() }
  return withAnalyticsRead(read, async () => {
    const result = await cachedAnalyticsRead<DashboardResult>(authz, `dashboard:${slug}`, { ...query, tab }, () => loaders[slug](query), { identity })
    const observedAt = new Date(read.observedAt).toISOString()
    const data = result.data ? { ...result.data, _analyticsRead: { slug, tab, observedAt, query: analyticsQueryString(query) } } : result.data
    return { ...result, data, observedAt } as unknown as Awaited<ReturnType<typeof loaders[S]>> & { observedAt: string }
  })
}
