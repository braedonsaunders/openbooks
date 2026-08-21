import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { neg } from '@openbooks/engine/src/money.ts'
import { setTimesheetWeekStatus, weekStart, weekWindow } from '../app/api/timesheets/_lib'
import { lockReasonsFor } from './time-lifecycle'

/**
 * Create an offsetting draft time entry that amends a consumed original.
 *
 * Once hours are invoiced, paid, costed or ticketed they are evidence for a
 * document that already exists — reopen is refused. The correction is a new
 * row pointing back at the original (`amends_entry_id`), never an edit of
 * history. The offsetting hours are the negation of the original so a later
 * approval posts the reverse labour / billing impact.
 */
export async function amendTimeEntry(
  orgId: string,
  actorId: string,
  entryId: string,
): Promise<{ id: string; amendsEntryId: string; amended: number }> {
  return withOrgTransaction(orgId, async () => {
    const src = (await db.execute<{
      id: string
      employee_party_id: string
      worked_on: string
      hours: string
      time_type_id: string | null
      item_id: string | null
      project_id: string | null
      department_id: string | null
      memo: string | null
      is_billable: boolean
      custom: Record<string, unknown> | null
      invoiced_by_line_id: string | null
      payroll_batch_ref: string | null
      cost_journal_entry_id: string | null
      field_ticket_id: string | null
      billing_status: 'unbilled' | 'billed'
      amends_entry_id: string | null
    }>(sql`
      select id, employee_party_id, worked_on, hours, time_type_id, item_id,
             project_id, department_id, memo, is_billable, custom,
             invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id,
             field_ticket_id, billing_status, amends_entry_id
        from time_entries
       where id = ${entryId} and org_id = ${orgId}
       for update
    `))
    const row = src.rows[0]
    if (!row) throw new Error('time entry not found')
    if (row.amends_entry_id) throw new Error('an amendment cannot itself be amended — amend the original')
    const already = (await db.execute(sql`
      select 1 from time_entries
       where org_id = ${orgId} and amends_entry_id = ${entryId}
       limit 1
    `))
    if (already.rows.length) throw new Error('this entry already has an amendment')

    const inserted = await insertAmendment(orgId, actorId, row)
    // The week header stays "approved" until we clear it — otherwise the
    // offset sits in a read-only week and the replacement hours cannot be
    // entered.
    await setTimesheetWeekStatus(orgId, row.employee_party_id, weekStart(row.worked_on), 'draft', actorId, null)
    return { id: inserted, amendsEntryId: entryId, amended: 1 }
  })
}

type AmendableRow = {
  id: string
  employee_party_id: string
  worked_on: string
  hours: string
  time_type_id: string | null
  item_id: string | null
  project_id: string | null
  department_id: string | null
  memo: string | null
  is_billable: boolean
  custom: Record<string, unknown> | null
  invoiced_by_line_id: string | null
  payroll_batch_ref: string | null
  cost_journal_entry_id: string | null
  field_ticket_id: string | null
  billing_status: 'unbilled' | 'billed'
  amends_entry_id: string | null
  status?: string
}

async function insertAmendment(
  orgId: string,
  actorId: string,
  row: AmendableRow,
): Promise<string> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into time_entries
      (org_id, employee_party_id, worked_on, hours, time_type_id, item_id,
       project_id, department_id, memo, is_billable, status, custom,
       amends_entry_id, created_by, updated_by)
    values
      (${orgId}, ${row.employee_party_id}, ${row.worked_on}, ${neg(row.hours)},
       ${row.time_type_id}, ${row.item_id}, ${row.project_id}, ${row.department_id},
       ${row.memo}, ${row.is_billable}, 'draft', ${JSON.stringify(row.custom ?? {})}::jsonb,
       ${row.id}, ${actorId}, ${actorId})
    returning id
  `))
  return inserted.rows[0]!.id
}

/**
 * Offset every consumed original in a week. Free approved hours stay posted;
 * only locked entries get an amendment. The week returns to draft so the
 * replacement hours can be entered on new lines.
 */
export async function amendLockedWeek(
  orgId: string,
  actorId: string,
  employeeId: string,
  sundayIso: string,
): Promise<{ amended: number }> {
  return withOrgTransaction(orgId, async () => {
    const week = weekStart(sundayIso)
    const days = weekWindow(week)

    const src = (await db.execute<AmendableRow>(sql`
      select id, employee_party_id, worked_on, hours, time_type_id, item_id,
             project_id, department_id, memo, is_billable, custom,
             invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id,
             field_ticket_id, billing_status, amends_entry_id, status
        from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${employeeId}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
       for update
    `))

    let amended = 0
    for (const row of src.rows) {
      if (row.amends_entry_id) continue
      if (row.status !== 'approved') continue
      const locks = lockReasonsFor({
        invoicedByLineId: row.invoiced_by_line_id,
        payrollBatchRef: row.payroll_batch_ref,
        costJournalEntryId: row.cost_journal_entry_id,
        fieldTicketId: row.field_ticket_id,
        billingStatus: row.billing_status,
      })
      if (locks.length === 0) continue
      const already = (await db.execute(sql`
        select 1 from time_entries
         where org_id = ${orgId} and amends_entry_id = ${row.id}
         limit 1
      `))
      if (already.rows.length) continue
      await insertAmendment(orgId, actorId, row)
      amended += 1
    }
    if (amended === 0) throw new Error('no locked entries to amend')
    await setTimesheetWeekStatus(orgId, employeeId, week, 'draft', actorId, null)
    return { amended }
  })
}
