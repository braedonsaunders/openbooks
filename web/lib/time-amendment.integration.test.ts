import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { amendTimeEntry } = await import('./time-amendment')
const { approveSubmittedTimeEntries } = await import('./time-approval')

/**
 * An amendment is the exact financial negation of the consumed original. It
 * must carry the original's approval-time snapshots (bill rate, cost rate,
 * costing basis, task) so approving it re-derives nothing: today's rate books
 * and wages must not leak into a correction of yesterday's evidence, and an
 * amendment of ESTIMATED time must not post a phantom negative overhead pair.
 */
test('an amendment carries the original snapshots and approves as an exact contra', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const employee = randomUUID(), project = randomUUID(), task = randomUUID(), original = randomUUID()
      // Week of the fixture date (2026-07-15 is a Wednesday; the week starts Sunday 2026-07-12).
      const week = '2026-07-12'
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
        overheadApplication: { mode: 'net_zero_pair', accountId: org.accounts.adjustment },
      })}::jsonb where id = ${org.orgId}`)
      // Today's resolvers would produce DIFFERENT numbers than the snapshots:
      // item default 125 vs snapshot 100, wage 50 vs snapshot cost 30.
      await db.execute(sql`update items set default_rate = '125.0000' where org_id = ${org.orgId} and id = ${org.items.service}`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Amended worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into labor_cost_rates (id, org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active)
        values (${randomUUID()}, ${org.orgId}, ${employee}, 'CAD', '50.0000', 'hour', '2080.0000', '2026-01-01', true)`)
      await db.execute(sql`insert into overhead_rates (id, org_id, method, rate_kind, rate_percent, effective_from)
        values (${randomUUID()}, ${org.orgId}, 'standard', 'per_hour', '12.5000', '2026-01-01')`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'AMEND', 'Amendment contra', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into project_tasks (id, org_id, project_id, name) values (${task}, ${org.orgId}, ${project}, 'Phase 1')`)
      await db.execute(sql`insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours, item_id, project_id, project_task_id, status, is_billable, memo_is_private,
         bill_rate, bill_rate_currency, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, costing_basis, payroll_batch_ref, custom, created_by, updated_by)
        values (${original}, ${org.orgId}, ${employee}, ${org.date}, '4.0000', ${org.items.service}, ${project}, ${task}, 'approved', true, true,
                '100.0000', 'CAD', '30.0000', 'CAD', ${org.subsidiaryId}, 'estimated', 'PAY-2026-07', '{}'::jsonb, ${actor}, ${actor})`)
      await db.execute(sql`insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status, approved_by, approved_at, created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, ${employee}, ${week}, 'approved', ${actor}, now(), ${actor}, ${actor})`)

      const { id: amendment } = await amendTimeEntry(org.orgId, actor, original)
      const snapshot = async () => (await db.execute<Record<string, unknown>>(sql`
        select hours::text as hours, bill_rate::text as bill_rate, cost_rate::text as cost_rate, costing_basis,
               project_task_id, memo_is_private, field_ticket_id, status, overhead_journal_entry_id
          from time_entries where org_id = ${org.orgId} and id = ${amendment}`)).rows[0]!
      assert.deepEqual(await snapshot(), {
        hours: '-4.0000', bill_rate: '100.0000', cost_rate: '30.0000', costing_basis: 'estimated',
        project_task_id: task, memo_is_private: true, field_ticket_id: null, status: 'draft', overhead_journal_entry_id: null,
      })

      // Approve the amendment through the real approval path (snapshots + overhead pair).
      await db.execute(sql`update time_entries set status = 'submitted' where org_id = ${org.orgId} and id = ${amendment}`)
      await db.execute(sql`update timesheet_weeks set status = 'submitted' where org_id = ${org.orgId} and employee_party_id = ${employee} and week_start = ${week}`)
      const approved = await approveSubmittedTimeEntries({ orgId: org.orgId, actorId: actor, employeePartyId: employee, weekStart: week })
      assert.deepEqual(approved, [amendment])

      const after = await snapshot()
      assert.equal(after.status, 'approved')
      assert.equal(after.bill_rate, '100.0000', 'approval must not re-price the amendment from today\'s rate book')
      assert.equal(after.cost_rate, '30.0000', 'approval must not re-cost the amendment from today\'s wage')
      assert.equal(after.overhead_journal_entry_id, null, 'estimated time never carries the net-zero overhead pair')
      const net = (await db.execute<{ bill: string; cost: string }>(sql`
        select coalesce(sum(hours * coalesce(bill_rate, 0)), 0)::text as bill, coalesce(sum(hours * coalesce(cost_rate, 0)), 0)::text as cost
          from time_entries where org_id = ${org.orgId} and id in (${original}, ${amendment})`)).rows[0]!
      assert.deepEqual(net, { bill: '0.00000000', cost: '0.00000000' })
      const overheadJournals = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id = ${org.orgId} and origin = 'overhead_applied'`)).rows[0]!.n
      assert.equal(overheadJournals, 0)
    } finally {
      await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`)
      await dropScratchOrg(org.orgId)
    }
  })
})
