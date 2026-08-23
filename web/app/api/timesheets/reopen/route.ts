import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { canReopenWeek, type EntryProvenance } from '../../../../lib/time-lifecycle'
import { isIsoDate, loadWeek, pinTimesheetEmployee, setTimesheetWeekStatus, weekStart, weekWindow } from '../_lib'

export const runtime = 'nodejs'

function bad(error: string, extra: Record<string, unknown> = {}, status = 422) {
  return NextResponse.json({ error, ...extra }, { status })
}

interface Body {
  employee?: string
  week?: string
}

/**
 * POST { employee, week } → return an approved week to draft so it can be
 * corrected.
 *
 * Guarded on `time.reopen`, deliberately NOT `time.approve`: whoever approves
 * hours should not also be able to silently unwind an approval that payroll or
 * billing has already relied on. The lock itself is enforced here, not in the
 * UI — a week is reopenable only while no entry has been invoiced, paid, cost-
 * posted or pulled into a field ticket. Once any of those is true the record is
 * evidence for a document that already exists and the correction is an
 * amendment, not an edit.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.reopen', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const employee = await pinTimesheetEmployee(orgId, body.employee)
  if (!employee) return bad('Employee not found')
  const week = weekStart(body.week)
  const days = weekWindow(week)
  const weekFrom = days[0]!
  const weekTo = days[6]!

  const before = await loadWeek(orgId, employee, week)
  if (before.status !== 'approved') return bad('Only an approved week can be reopened')

  return withOrgTransaction(orgId, async () => {
    const rows = ((await db.execute<{
        invoiced_by_line_id: string | null
        payroll_batch_ref: string | null
        cost_journal_entry_id: string | null
        overhead_journal_entry_id: string | null
        field_ticket_id: string | null
        billing_status: 'unbilled' | 'billed'
      }>(sql`
      select invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id,
             overhead_journal_entry_id, field_ticket_id, billing_status
        from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and status = 'approved'
       for update`))).rows

    const entries: EntryProvenance[] = rows.map((r) => ({
      invoicedByLineId: r.invoiced_by_line_id,
      payrollBatchRef: r.payroll_batch_ref,
      costJournalEntryId: r.cost_journal_entry_id,
      overheadJournalEntryId: r.overhead_journal_entry_id,
      fieldTicketId: r.field_ticket_id,
      billingStatus: r.billing_status,
    }))

    const decision = canReopenWeek(entries)
    if (!decision.allowed) {
      return bad('This week can no longer be reopened', {
        reasons: decision.reasons,
        lockedCount: decision.lockedCount,
      })
    }

    // Clear the approval stamp with the status: a row reading "draft" while it
    // still names an approver would misreport who signed off on what.
    await setTimesheetWeekStatus(orgId, employee, week, 'draft', user.id, null)
    await db.execute(sql`
      update time_entries
         set status = 'draft', approved_by = null, approved_at = null,
             rejection_reason = null, updated_by = ${user.id}, updated_at = now()
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and status = 'approved'`)

    return NextResponse.json(await loadWeek(orgId, employee, week))
  })
}
