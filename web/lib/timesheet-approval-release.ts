import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
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
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  comment?: string | null,
): Promise<void> {
  const parsed = await resolveTimesheetWeek(subjectId, orgId)
  if (!parsed) throw new Error(`unknown timesheet week: ${subjectId}`)
  const from = parsed.weekStart

  if (outcome === 'approved') {
    await approveSubmittedTimeEntries({
      orgId,
      actorId,
      employeePartyId: parsed.employeePartyId,
      weekStart: from,
      allowedSubsidiaryIds,
      comment,
    })
    return
  }

  // Rejection carries the approver's words. Without a reason the employee is
  // told only that it came back, which is the complaint every timesheet system
  // that skips this earns.
  const reason = (comment ?? '').trim() || 'Rejected by approver'
  const through = (await db.execute<{ d: string }>(sql`select (${from}::date + 6)::text as d`)).rows[0]!.d
  const header = (await db.execute<{ id: string; status: string }>(sql`
    select id, status from timesheet_weeks
     where org_id = ${orgId}
       and employee_party_id = ${parsed.employeePartyId}
       and week_start = ${from}::date
  `)).rows[0]
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
  // Durable decision evidence in the same unit as the status flip: the
  // documented reason is the point of a rejection, so it rides with the
  // before/after state exactly as the direct rejection does. An audit
  // failure rolls the release back with it.
  if (header) {
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify(
        {
          event: "rejected",
          actor: { kind: "user", userId: actorId },
          before: { status: header.status },
          after: { status: "rejected" },
          reason,
          weekStart: from,
        },
      )}::jsonb, ${actorId})
    `)
  }
}
