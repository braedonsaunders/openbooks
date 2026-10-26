import 'server-only'
import { withAuthzContext, requestAuthzContext } from '../authz-context'
import { requirePermission, ForbiddenError } from '../authz'
import { ANALYTICS_DASHBOARD_MAP, analyticsDashboardDenied } from './dashboard-catalog'
import { requireFeatureEnabled } from '../feature-gates'
import { analyticsTab, type AnalyticsSlug } from './dashboard-tabs'
import { analyticsCacheIdentity, analyticsPreviewKey } from './preview-cache'
import { latestProjection, rebuildProjection } from './latest-projection'
import { withAnalyticsRead } from './read-context'
import { analyticsSourceQuery, analyticsQueryString } from './query-params'

const loaders = {
  'receivables-intelligence': async (sp: Record<string, string | undefined>) => (await import('../../app/(app)/analytics/receivables-intelligence/view')).loadReceivablesIntelligence(sp),
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

/**
 * One Analytics dashboard view for the caller, answered from its latest
 * projection. A page render may answer a projection that is no longer
 * current (`answerStale`): it carries the time it was observed, and the
 * page's own read asks again at once and replaces it with the rebuilt one.
 * Every other caller (the dashboard read API, spotlights building their own
 * projection) receives a current projection, rebuilt first when needed.
 */
export async function readAnalyticsDashboard<S extends AnalyticsSlug>(
  slug: S,
  sp: Record<string, string | undefined>,
  options: { answerStale?: boolean } = {},
): Promise<Awaited<ReturnType<typeof loaders[S]>> & { observedAt: string }> {
  const authz = await requirePermission('reports.read')
  const definition = ANALYTICS_DASHBOARD_MAP[slug]!
  const denied = analyticsDashboardDenied(authz, definition)
  if (denied) throw new ForbiddenError(denied)
  if (definition.feature) await requireFeatureEnabled(authz.user.orgId, definition.feature)
  const tab = analyticsTab(slug, sp.tab)
  const query = analyticsSourceQuery(sp, slug)
  return withAuthzContext(authz, async () => {
    const authority = requestAuthzContext()!
    const identity = await analyticsCacheIdentity(authority.user.orgId)
    const read = { authz: authority, slug, tab, projection: 'tab' as const, ...identity, observedAt: Date.now() }
    return withAnalyticsRead(read, async () => {
      const key = analyticsPreviewKey(authority, `dashboard-view:${slug}`, { ...query, tab }, identity.locale, 'latest')
      const build = () => loaders[slug](query) as Promise<DashboardResult>
      const observed = () => new Date(read.observedAt).toISOString()
      let projection = await latestProjection(key, identity.revision, build, observed)
      if (projection.refreshing && !options.answerStale) projection = await rebuildProjection(key, identity.revision, build, observed)
      const result = projection.data
      const observedAt = projection.observedAt
      const data = result.data ? { ...result.data, _analyticsRead: { slug, tab, observedAt, query: analyticsQueryString(query, slug) } } : result.data
      return { ...result, data, observedAt } as unknown as Awaited<ReturnType<typeof loaders[S]>> & { observedAt: string }
    })
  })
}
