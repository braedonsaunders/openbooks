import { redirect } from 'next/navigation'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import {
  currentWeekStart,
  isIsoDate,
  loadPickers,
  loadWeek,
  userEmployeeId,
  weekStart,
} from '../../../api/timesheets/_lib'
import { WeeklyGrid } from '../WeeklyGrid'

export const dynamic = 'force-dynamic'

/**
 * Weekly time-entry editor. A page (not a flyout) because the seven-day matrix
 * needs the full width — justified like the project cockpit. Reads the employee
 * + week from the query; defaults to the signed-in user's linked employee and
 * the current week.
 */
export default async function TimesheetEntry({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'time.manage')
  const canApprove = can(authz, 'time.approve')

  const sp = await searchParams
  const employeeParam = pickString(sp.employee)
  const weekParam = pickString(sp.week)

  // Resolve the target employee: query param → signed-in user's employee.
  let employeeId = employeeParam && isUuid(employeeParam) ? employeeParam : null
  if (!employeeId) employeeId = await userEmployeeId(orgId, authz.user.id)

  const week = weekParam && isIsoDate(weekParam) ? weekStart(weekParam) : currentWeekStart()

  const pickers = await loadPickers(orgId)

  // No resolvable employee → seed with the first active one so the picker isn't
  // empty (the user can switch). If there are none at all, show the empty grid.
  if (!employeeId) {
    const first = pickers.employees[0]?.value
    if (first) redirect(`/timesheets/entry?employee=${first}&week=${week}`)
  }

  // Normalize the URL to the canonical Sunday if a mid-week date was passed.
  if (employeeId && weekParam && isIsoDate(weekParam) && weekParam !== week) {
    redirect(`/timesheets/entry?employee=${employeeId}&week=${week}`)
  }

  const payload = employeeId
    ? await loadWeek(orgId, employeeId, week)
    : { employeeId: null, week, days: [], rows: [], status: 'empty' as const, hasApproved: false }

  return (
    <WeeklyGrid
      employeeId={employeeId}
      week={week}
      payload={payload}
      pickers={pickers}
      canManage={canManage}
      canApprove={canApprove}
    />
  )
}
