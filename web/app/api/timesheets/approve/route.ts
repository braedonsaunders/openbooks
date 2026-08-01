import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { approveSubmittedTimeEntries } from '../../../../lib/time-approval'
import { isIsoDate, loadWeek, weekStart, weekWindow } from '../_lib'

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

  const body = (await req.json()) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const week = weekStart(body.week)
  const days = weekWindow(week)

  try {
    await approveSubmittedTimeEntries({
      orgId,
      actorId: user.id,
      employeePartyId: body.employee,
      from: days[0],
      to: days[6],
    })
  } catch (error) {
    console.error('[timesheets/approve] approval transaction rolled back:', error)
    return NextResponse.json(
      { error: 'Time approval could not complete its configured financial effects. No entries were approved.' },
      { status: 409 },
    )
  }

  const payload = await loadWeek(orgId, body.employee, week)
  return NextResponse.json(payload)
}
