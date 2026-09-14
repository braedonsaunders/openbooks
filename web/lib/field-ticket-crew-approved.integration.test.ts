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
const { createFieldTicket, saveCrewGrid, loadFieldTicket, FieldTicketError } = await import('./field-tickets')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * Crew hours have an independent timesheet approval lifecycle: an entry can be
 * approved while its ticket is still a draft. The grid must fail loudly when a
 * save targets such an entry — its UPDATE/DELETE only touches draft rows, so
 * without a row-count check the save reports success while changing nothing.
 */
test('the crew grid refuses to silently rewrite approved entries', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const timeTypeId = randomUUID()
      await db.execute(sql`insert into time_types
        (id, org_id, name, is_active, show_on_field_ticket, classification)
        values (${timeTypeId}, ${org.orgId}, 'Straight', true, true, 'regular')`)
      const employeeId = randomUUID()
      await db.execute(sql`insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Approved Hand', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into employee_roles (party_id, org_id, is_active)
        values (${employeeId}, ${org.orgId}, true)`)
      const projectId = randomUUID()
      await db.execute(sql`insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'CREW-APP', 'Approved crew job',
                ${org.customerId}, 'active', true, '{}'::jsonb)`)

      const created = await createFieldTicket(org.orgId, actor, { projectId })
      const loaded = await loadFieldTicket(org.orgId, created.id)
      const day = loaded.fieldTicket.periodStart
      const grid = (revision: string, hours: Record<string, string>) => saveCrewGrid(org.orgId, actor, created.id, [
        { employeePartyId: employeeId, itemId: null, timeTypeId, hours },
      ], revision, null)
      await grid(loaded.revision, { [day]: '8' })

      // The timesheet lifecycle approves the entry while the ticket is draft.
      await db.execute(sql`update time_entries set status = 'approved'
       where org_id = ${org.orgId} and field_ticket_id = ${created.id}`)
      const revision = (await loadFieldTicket(org.orgId, created.id)).revision

      // A changed cell must fail instead of reporting a save that did nothing.
      await assert.rejects(
        grid(revision, { [day]: '6' }),
        (e) => e instanceof FieldTicketError && /approved/.test(e.message),
      )
      const hours = (await db.execute<{ hours: string }>(sql`
        select hours::text as hours from time_entries
         where org_id = ${org.orgId} and field_ticket_id = ${created.id}`)).rows[0]!.hours
      assert.equal(Number(hours), 8)

      // A cleared cell must fail too — the approved entry is not deleted.
      await assert.rejects(
        grid((await loadFieldTicket(org.orgId, created.id)).revision, {}),
        (e) => e instanceof FieldTicketError && /approved/.test(e.message),
      )
      const remaining = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from time_entries
         where org_id = ${org.orgId} and field_ticket_id = ${created.id}`)).rows[0]!.n
      assert.equal(remaining, 1)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
