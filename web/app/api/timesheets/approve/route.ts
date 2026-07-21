import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { approveProjectLaborTime } from '@openbooks/engine/src/project-recognition.ts'
import { LaborRateError } from '@openbooks/engine/src/labor-rates.ts'
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
  const gate = await guardPermission('time.approve')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const body = (await req.json()) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const week = weekStart(body.week)
  const days = weekWindow(week)

  try {
    await approveProjectLaborTime({
      orgId,
      actorId: user.id,
      employeePartyId: body.employee,
      from: days[0],
      to: days[6],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Labor rate resolution failed'
    return NextResponse.json(
      { error: message, code: error instanceof LaborRateError ? error.code : 'posting' },
      { status: 422 },
    )
  }

  const payload = await loadWeek(orgId, body.employee, week)
  return NextResponse.json(payload)
}
