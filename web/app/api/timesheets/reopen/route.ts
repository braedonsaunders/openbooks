import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
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
  const employee = await pinTimesheetEmployee(orgId, body.employee, gate.allowedSubsidiaryIds)
  if (!employee) return bad('Employee not found')
  const week = weekStart(body.week)
  const days = weekWindow(week)
  const weekFrom = days[0]!
  const weekTo = days[6]!

  // Fast path only: the authoritative state check happens under the header
  // lock inside the transaction, where a concurrent reopen's commit is
  // visible and the loser is refused instead of auditing a phantom unwind.
  const before = await loadWeek(orgId, employee, week, gate.allowedSubsidiaryIds)
  if (before.status !== 'approved') return bad('Only an approved week can be reopened')

  return withOrgTransaction(orgId, async () => {
    // Lock the header FIRST — the same order approval uses (header, then
    // entries) — so a concurrent approval cannot deadlock against this
    // reopen. The locked status is the authoritative state check: the
    // pre-transaction read above is only a fast path, and a replay that
    // passed it before the winner committed observes draft here and is
    // refused instead of writing a second 'reopened' audit over a week that
    // is already draft.
    const header = ((await db.execute<{ id: string; status: string }>(sql`
      select id, status from timesheet_weeks
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and week_start = ${week}::date
       for update
    `)).rows[0])
    if (!header || header.status !== 'approved') {
      return bad('Only an approved week can be reopened')
    }

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

    // Weeks carrying amendment history correct forward only. Reopening would
    // return an amended original to draft, where the weekly save deletes or
    // replaces it under a new id — orphaning the offset into phantom negative
    // hours with no original to negate. Inspect the link in both directions:
    // offsets pointing back at an original, and originals pointed at by an
    // offset. Either side makes the week append-only.
    const offsets = ((await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from time_entries entry
       where entry.org_id = ${orgId}
         and entry.employee_party_id = ${employee}
         and entry.worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and (
           entry.amends_entry_id is not null
           or exists (
             select 1 from time_entries contra
              where contra.org_id = entry.org_id
                and contra.amends_entry_id = entry.id
           )
         )`))).rows[0]!.n
    if (Number(offsets) > 0) {
      return bad('This week carries amendment offsets — correct it with a new amendment, not a reopen', {
        reasons: ['amended'],
        lockedCount: Number(offsets),
      })
    }

    // Clear the approval stamp with the status: a row reading "draft" while it
    // still names an approver would misreport who signed off on what. The
    // header locked at the top of this transaction is the audit before-image:
    // it was verified approved under the lock, so the audit names the state
    // this unwind actually transitions from.
    await setTimesheetWeekStatus(
      orgId,
      employee,
      week,
      'draft',
      user.id,
      null,
      gate.allowedSubsidiaryIds,
    )
    await db.execute(sql`
      update time_entries
         set status = 'draft', approved_by = null, approved_at = null,
             rejection_reason = null, updated_by = ${user.id}, updated_at = now()
       where org_id = ${orgId}
         and employee_party_id = ${employee}
         and worked_on >= ${weekFrom} and worked_on <= ${weekTo}
         and status = 'approved'`)
    // Durable unwind evidence, part of the same atomic unit: unwinding an
    // approval without it would leave hours editable again with no record of
    // who cleared the sign-off. An audit failure rolls the reopen back with it.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'timesheet_weeks', ${header.id}, 'update', ${JSON.stringify({
        event: 'reopened',
        actor: { kind: 'user', userId: user.id },
        before: { status: header.status },
        after: { status: 'draft' },
        weekStart: week,
      })}::jsonb, ${user.id})
    `)

    return NextResponse.json(await loadWeek(orgId, employee, week, gate.allowedSubsidiaryIds))
  })
}
