import { redirect } from 'next/navigation'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import {
  currentWeekStart,
  isIsoDate,
  userEmployeeId,
  weekStart,
} from '../../../api/timesheets/_lib'

export const dynamic = 'force-dynamic'

/**
 * Legacy entry point. The weekly editor is a flyout over the timesheet list
 * now, like every other record, so this only translates the old
 * `?employee=&week=` links into the list's `?timesheet=<employee>:<week>`.
 */
export default async function TimesheetEntry({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('time.read')
  await requireFeatureEnabled(authz.user.orgId, 'timeTracking')

  const sp = await searchParams
  const employeeParam = pickString(sp.employee)
  const weekParam = pickString(sp.week)

  let employeeId = employeeParam && isUuid(employeeParam) ? employeeParam : null
  if (!employeeId) employeeId = await userEmployeeId(authz.user.orgId, authz.user.id)

  const week = weekParam && isIsoDate(weekParam) ? weekStart(weekParam) : currentWeekStart()

  redirect(employeeId ? `/timesheets?timesheet=${employeeId}:${week}` : '/timesheets')
}
