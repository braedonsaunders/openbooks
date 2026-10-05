import 'server-only'
import type { Authz } from '../authz'
import { isFeatureEnabled } from '../features'
import { analyticsDashboardDenied, type AnalyticsDashboardDefinition } from './dashboard-catalog'

/** Shared by the dashboard library and live preview API. */
export async function analyticsDashboardAvailable(authz: Authz, dashboard: AnalyticsDashboardDefinition): Promise<boolean> {
  if (analyticsDashboardDenied(authz, dashboard) !== null) return false
  if (dashboard.feature && !(await isFeatureEnabled(authz.user.orgId, dashboard.feature))) return false
  return true
}
