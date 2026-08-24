import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { resolveTimesheetWeek } from '@openbooks/engine/src/flows/timesheet-weeks-adapter.ts'
import { approveSubmittedTimeEntries } from './time-approval'
import { setTimesheetWeekStatus } from '../app/api/timesheets/_lib'

/**
 * Apply a flow gate's decision to a timesheet week.
 *
 * Flows owns the routing — who approves, in what order, with what quorum. This
 * owns what approval MEANS for hours: stamping the approver on every entry (so
 * downstream costing and billing can rely on it), or bouncing the week back
 * with the approver's comment as the reason the employee will read.
 *
 * Runs inside decideGate's transaction, so throwing rolls the gate decision
 * back with it.
 */
export async function releaseTimesheetWeekApproval(
  orgId: string,
  actorId: string,
  subjectId: string,
  outcome: 'approved' | 'rejected',
  comment?: string | null,
): Promise<void> {
  const parsed = await resolveTimesheetWeek(subjectId, orgId)
  if (!parsed) throw new Error(`unknown timesheet week: ${subjectId}`)
  const from = parsed.weekStart
  const to = (await db.execute<{ d: string }>(sql`select (${from}::date + 6)::text as d`))
  const through = to.rows[0]!.d

  if (outcome === 'approved') {
    await approveSubmittedTimeEntries({
      orgId,
      actorId,
      employeePartyId: parsed.employeePartyId,
      from,
      to: through,
    })
    await setTimesheetWeekStatus(
      orgId, parsed.employeePartyId, from, 'approved', actorId, null,
    )
    return
  }

  // Rejection carries the approver's words. Without a reason the employee is
  // told only that it came back, which is the complaint every timesheet system
  // that skips this earns.
  const reason = (comment ?? '').trim() || 'Rejected by approver'
  await setTimesheetWeekStatus(
    orgId, parsed.employeePartyId, from, 'rejected', actorId, reason,
  )
  await db.execute(sql`
    update time_entries
       set status = 'rejected', rejection_reason = ${reason},
           approved_by = null, approved_at = null,
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId}
       and employee_party_id = ${parsed.employeePartyId}
       and worked_on >= ${from} and worked_on <= ${through}
       and status = 'submitted'`)
}
