import 'server-only'
import { can, type Authz } from '../authz'
import { isFeatureEnabled } from '../features'
import { sentinelAccessDenied } from './sentinel-access'
import type { AnalyticsDashboardDefinition } from './dashboard-catalog'

/** Shared by the dashboard library and live preview API. */
export async function analyticsDashboardAvailable(authz: Authz, dashboard: AnalyticsDashboardDefinition): Promise<boolean> {
  if (!can(authz, 'reports.read')) return false
  if (dashboard.permission && !can(authz, dashboard.permission)) return false
  if (dashboard.unrestricted && authz.allowedSubsidiaryIds !== null) return false
  if (dashboard.slug === 'sentinel' && sentinelAccessDenied(authz)) return false
  if (dashboard.feature && !(await isFeatureEnabled(authz.user.orgId, dashboard.feature))) return false
  return true
}
