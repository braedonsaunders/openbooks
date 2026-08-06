import 'server-only'
import { getAuthz } from './authz'
import { statementDefinitionId } from './custom-reports'

/**
 * One-liner for statement pages: the definition id their ScheduleReportButton
 * hangs off, plus the page's current string params as the schedule snapshot.
 */
export async function reportScheduleAnchor(
  kind: string,
  match: Record<string, string> = {},
): Promise<string | null> {
  const authz = await getAuthz()
  if (!authz) return null
  return statementDefinitionId(authz.user.orgId, kind, match)
}

/** Current-page params worth snapshotting onto a schedule (string values only). */
export function scheduleParamsFrom(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string' && value && value.length <= 256) out[key] = value
  }
  return out
}
