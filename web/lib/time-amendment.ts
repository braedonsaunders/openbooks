import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { neg } from '@openbooks/engine/src/money.ts'

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
): Promise<{ id: string; amendsEntryId: string }> {
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

    const inserted = (await db.execute<{ id: string }>(sql`
      insert into time_entries
        (org_id, employee_party_id, worked_on, hours, time_type_id, item_id,
         project_id, department_id, memo, is_billable, status, custom,
         amends_entry_id, created_by, updated_by)
      values
        (${orgId}, ${row.employee_party_id}, ${row.worked_on}, ${neg(row.hours)},
         ${row.time_type_id}, ${row.item_id}, ${row.project_id}, ${row.department_id},
         ${row.memo}, ${row.is_billable}, 'draft', ${JSON.stringify(row.custom ?? {})}::jsonb,
         ${entryId}, ${actorId}, ${actorId})
      returning id
    `))
    return { id: inserted.rows[0]!.id, amendsEntryId: entryId }
  })
}
