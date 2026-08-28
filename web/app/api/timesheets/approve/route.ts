import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { approveSubmittedTimeEntries } from '../../../../lib/time-approval'
import { isIsoDate, loadWeek, pinTimesheetEmployee, weekStart } from '../_lib'

export const runtime = 'nodejs'

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

interface Body {
  employee?: string
  week?: string
}

/**
 * POST { employee, week } → approve the week: submitted entries become
 * approved, stamped with the approver and timestamp. Draft entries are left
 * alone (submit them first) so approval is an explicit two-step gate.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.approve', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const ownedEmployee = await pinTimesheetEmployee(orgId, body.employee, gate.allowedSubsidiaryIds)
  if (!ownedEmployee) return bad('Employee not found')
  const week = weekStart(body.week)

  try {
    await approveSubmittedTimeEntries({
      orgId,
      actorId: user.id,
      employeePartyId: ownedEmployee,
      weekStart: week,
    })
  } catch (error) {
    console.error('[timesheets/approve] approval transaction rolled back:', error)
    return NextResponse.json(
      { error: 'Time approval could not complete its configured financial effects. No entries were approved.' },
      { status: 409 },
    )
  }

  const payload = await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds)
  return NextResponse.json(payload)
}
