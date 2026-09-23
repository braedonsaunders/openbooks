import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { isIsoDate, loadWeek, pinTimesheetEmployee, setTimesheetWeekStatus, weekStart, weekWindow } from '../_lib'

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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const ownedEmployee = await pinTimesheetEmployee(orgId, body.employee, gate.allowedSubsidiaryIds)
  if (!ownedEmployee) return bad('Employee not found')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 3) return bad('A rejection reason is required')
  if (reason.length > 500) return bad('Rejection reason is too long')

  const week = weekStart(body.week)
  const days = weekWindow(week)

  // Fast path only: the authoritative state check happens under the header
  // lock inside the transaction, where a concurrent rejection's commit is
  // visible and the replay loser is refused with the original reason intact.
  // A replayed rejection names the recorded decision either way — never the
  // replayed reason.
  const before = await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds)
  if (before.status !== 'submitted') {
    if (before.status === 'rejected' && before.rejectionReason) {
      return bad(`Week already rejected: ${before.rejectionReason} — submit the week again to re-decide it`)
    }
    return bad('Only a submitted week can be rejected')
  }

  try {
    return await withOrgTransaction(orgId, async () => {
      // The locked header is the claim, not the pre-transaction read: a
      // replay that passed the fast path before the winner committed
      // observes rejected here and is refused before it can overwrite the
      // recorded reason with zero submitted rows changed.
      const header = ((await db.execute<{ id: string; status: string; rejection_reason: string | null }>(sql`
        select id, status, rejection_reason from timesheet_weeks
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and week_start = ${week}::date
         for update
      `)).rows[0])
      if (!header || header.status !== 'submitted') {
        if (header?.status === 'rejected') {
          return bad(
            `Week already rejected${header.rejection_reason ? `: ${header.rejection_reason}` : ''} — submit the week again to re-decide it`,
          )
        }
        return bad('Only a submitted week can be rejected')
      }
      await setTimesheetWeekStatus(
        orgId,
        ownedEmployee,
        week,
        'rejected',
        user.id,
        reason,
        gate.allowedSubsidiaryIds,
      )
      // Conditional update: the flipped-row count is the proof anything was
      // submitted. Zero means the header said submitted but no entry was —
      // throwing rolls the header stamp back instead of recording a reason
      // over an empty rejection.
      const moved = await db.execute(sql`
        update time_entries
           set status = 'rejected', rejection_reason = ${reason},
               approved_by = null, approved_at = null,
               updated_by = ${user.id}, updated_at = now()
         where org_id = ${orgId}
           and employee_party_id = ${ownedEmployee}
           and worked_on >= ${days[0]} and worked_on <= ${days[6]}
           and status = 'submitted'`)
      if ((moved.rowCount ?? 0) === 0) {
        throw new Error('Nothing to reject — the week has no submitted entries')
      }
      // Durable decision evidence, part of the same atomic unit: the
      // documented reason is the point of a rejection, so it rides with the
      // before/after status. An audit failure rolls the rejection back
      // with it.
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify({
          event: 'rejected',
          actor: { kind: 'user', userId: user.id },
          before: { status: header.status },
          after: { status: 'rejected' },
          reason,
          weekStart: week,
        })}::jsonb, ${user.id})
      `)

      return NextResponse.json(await loadWeek(orgId, ownedEmployee, week, gate.allowedSubsidiaryIds))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/nothing to reject/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 422 })
    }
    throw error
  }
}
