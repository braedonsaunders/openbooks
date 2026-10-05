import 'server-only'
import { BUILT_IN_REPORT_DEFINITION_MAP } from '@openbooks/reports'
import { can, type Authz } from '../authz'
import { isFeatureEnabled } from '../features'
import { canRunReportEntity } from '../report-authz'
import { sentinelAccessDenied } from './sentinel-access'
import type { AnalyticsDashboardDefinition } from './dashboard-catalog'

/** Shared by the launcher, preview API and direct analytical report route. */
export async function analyticsDashboardAvailable(authz: Authz, dashboard: AnalyticsDashboardDefinition): Promise<boolean> {
  if (!can(authz, 'reports.read')) return false
  if (dashboard.permission && !can(authz, dashboard.permission)) return false
  if (dashboard.unrestricted && authz.allowedSubsidiaryIds !== null) return false
  if (dashboard.slug === 'sentinel' && sentinelAccessDenied(authz)) return false
  if (dashboard.feature && !(await isFeatureEnabled(authz.user.orgId, dashboard.feature))) return false
  if (dashboard.reportSlug) {
    const report = BUILT_IN_REPORT_DEFINITION_MAP[dashboard.reportSlug]
    return Boolean(report && await canRunReportEntity(authz, report.query))
  }
  return true
}
