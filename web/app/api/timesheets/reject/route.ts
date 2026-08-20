import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { isIsoDate, loadWeek, setTimesheetWeekStatus, weekStart, weekWindow } from '../_lib'

export const runtime = 'nodejs'

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

interface Body {
  employee?: string
  week?: string
  reason?: string
}

/**
 * POST { employee, week, reason } → bounce a submitted week back to the person
 * who entered it.
 *
 * The reason is required and stored on the rows. A rejection that only flips a
 * status leaves the employee guessing at what to fix, and leaves no record of
 * why an approver declined — the documented decision is the point.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.approve', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const body = (await req.json()) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 3) return bad('A rejection reason is required')
  if (reason.length > 500) return bad('Rejection reason is too long')

  const week = weekStart(body.week)
  const days = weekWindow(week)

  const before = await loadWeek(orgId, body.employee, week)
  if (before.status !== 'submitted') return bad('Only a submitted week can be rejected')

  await setTimesheetWeekStatus(orgId, body.employee, week, 'rejected', user.id, reason)
  await db.execute(sql`
    update time_entries
       set status = 'rejected', rejection_reason = ${reason},
           approved_by = null, approved_at = null,
           updated_by = ${user.id}, updated_at = now()
     where org_id = ${orgId}
       and employee_party_id = ${body.employee}
       and worked_on >= ${days[0]} and worked_on <= ${days[6]}
       and status = 'submitted'`)

  return NextResponse.json(await loadWeek(orgId, body.employee, week))
}
