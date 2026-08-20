import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { canReopenWeek, type EntryProvenance } from '../../../../lib/time-lifecycle'
import { isIsoDate, loadWeek, setTimesheetWeekStatus, weekStart, weekWindow } from '../_lib'

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

  const body = (await req.json()) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const week = weekStart(body.week)
  const days = weekWindow(week)

  const before = await loadWeek(orgId, body.employee, week)
  if (before.status !== 'approved') return bad('Only an approved week can be reopened')

  const rows = ((await db.execute<{
      invoiced_by_line_id: string | null
      payroll_batch_ref: string | null
      cost_journal_entry_id: string | null
      field_ticket_id: string | null
    }>(sql`
    select invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id, field_ticket_id
      from time_entries
     where org_id = ${orgId}
       and employee_party_id = ${body.employee}
       and worked_on >= ${days[0]} and worked_on <= ${days[6]}
       and status = 'approved'`))).rows

  const entries: EntryProvenance[] = rows.map((r) => ({
    invoicedByLineId: r.invoiced_by_line_id,
    payrollBatchRef: r.payroll_batch_ref,
    costJournalEntryId: r.cost_journal_entry_id,
    fieldTicketId: r.field_ticket_id,
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
  await setTimesheetWeekStatus(orgId, body.employee, week, 'draft', user.id, null)
  await db.execute(sql`
    update time_entries
       set status = 'draft', approved_by = null, approved_at = null,
           rejection_reason = null, updated_by = ${user.id}, updated_at = now()
     where org_id = ${orgId}
       and employee_party_id = ${body.employee}
       and worked_on >= ${days[0]} and worked_on <= ${days[6]}
       and status = 'approved'`)

  return NextResponse.json(await loadWeek(orgId, body.employee, week))
}
