import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFieldTicket, saveCrewGrid, loadFieldTicket, FieldTicketError } = await import('./field-tickets')

/**
 * The crew grid pins its references exactly like the drawer pickers: a new
 * crew member must hold an active employee role in this org and sit in the
 * ticket's legal entity, and a new item must belong to this org. Rows already
 * stored on the ticket stay saveable so deactivating a person or item never
 * bricks an older draft.
 */
test('the crew grid refuses crew members, items, and days it cannot own', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    const alienOrg = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${alienOrg.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const timeTypeId = randomUUID()
      await db.execute(sql`insert into time_types
        (id, org_id, name, is_active, show_on_field_ticket, classification)
        values (${timeTypeId}, ${org.orgId}, 'Straight', true, true, 'regular')`)
      const employeeId = randomUUID()
      const customerId = randomUUID()
      await db.execute(sql`insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Crew Hand', ${org.subsidiaryId}, true, '{}'::jsonb),
               (${customerId}, ${org.orgId}, 'customer', 'Walk-in Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into employee_roles (party_id, org_id, is_active)
        values (${employeeId}, ${org.orgId}, true)`)
      const projectId = randomUUID()
      await db.execute(sql`insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'CREW-OWN', 'Crew ownership job',
                ${org.customerId}, 'active', true, '{}'::jsonb)`)

      const day = (await loadFieldTicket(org.orgId, (await createFieldTicket(org.orgId, actor, { projectId })).id)).fieldTicket.periodStart
      const ticketFor = async () => {
        const created = await createFieldTicket(org.orgId, actor, { projectId })
        const loaded = await loadFieldTicket(org.orgId, created.id)
        return { id: created.id, revision: loaded.revision, start: loaded.fieldTicket.periodStart, end: loaded.fieldTicket.periodEnd }
      }

      // A customer with no employee role is not crew.
      {
        const ticket = await ticketFor()
        await assert.rejects(
          saveCrewGrid(org.orgId, actor, ticket.id, [
            { employeePartyId: customerId, itemId: null, timeTypeId, hours: { [day]: '8' } },
          ], ticket.revision, null),
          (e) => e instanceof FieldTicketError && /active employee/.test(e.message),
        )
        const rows = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from time_entries
           where org_id = ${org.orgId} and field_ticket_id = ${ticket.id}`)).rows[0]!.n
        assert.equal(rows, 0, 'the refused grid writes nothing')
      }

      // An employee of another legal entity is not this ticket's crew.
      {
        const otherSub = randomUUID()
        await db.execute(sql`insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, is_active)
          values (${otherSub}, ${org.orgId}, ${org.subsidiaryId}, 'Other Legal', 'CAD', 'CA', true)`)
        const outsider = randomUUID()
        await db.execute(sql`insert into parties
          (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
          values (${outsider}, ${org.orgId}, 'employee', 'Outsider', ${otherSub}, true, '{}'::jsonb)`)
        await db.execute(sql`insert into employee_roles (party_id, org_id, is_active)
          values (${outsider}, ${org.orgId}, true)`)
        const ticket = await ticketFor()
        await assert.rejects(
          saveCrewGrid(org.orgId, actor, ticket.id, [
            { employeePartyId: outsider, itemId: null, timeTypeId, hours: { [day]: '8' } },
          ], ticket.revision, null),
          (e) => e instanceof FieldTicketError && /legal entity/.test(e.message),
        )
      }

      // An item from another org cannot ride on this ticket's hours.
      {
        const ticket = await ticketFor()
        await assert.rejects(
          saveCrewGrid(org.orgId, actor, ticket.id, [
            { employeePartyId: employeeId, itemId: alienOrg.items.service, timeTypeId, hours: { [day]: '8' } },
          ], ticket.revision, null),
          (e) => e instanceof FieldTicketError && /active item/.test(e.message),
        )
      }

      // Real hours outside the ticket window fail loudly instead of vanishing;
      // blank cells stay ignorable so a wider grid never blocks a save.
      {
        const ticket = await ticketFor()
        const outside = new Date(`${ticket.end}T12:00:00Z`)
        outside.setUTCDate(outside.getUTCDate() + 1)
        const outsideIso = outside.toISOString().slice(0, 10)
        await assert.rejects(
          saveCrewGrid(org.orgId, actor, ticket.id, [
            { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { [outsideIso]: '8' } },
          ], ticket.revision, null),
          (e) => e instanceof FieldTicketError && /outside this ticket/.test(e.message),
        )
        await assert.rejects(
          saveCrewGrid(org.orgId, actor, ticket.id, [
            { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { 'not-a-day': '8' } },
          ], ticket.revision, null),
          (e) => e instanceof FieldTicketError && /outside this ticket/.test(e.message),
        )
        const reloaded = await loadFieldTicket(org.orgId, ticket.id)
        await saveCrewGrid(org.orgId, actor, ticket.id, [
          { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { [outsideIso]: '', 'not-a-day': '' } },
        ], reloaded.revision, null)
      }

      // The service owns the scope boundary too; route preflight cannot be
      // the authority after a concurrent project rehome.
      const beforeTickets = (await db.execute<{n:number}>(sql`select count(*)::int n from field_tickets where org_id=${org.orgId}`)).rows[0]!.n
      await assert.rejects(createFieldTicket(org.orgId,actor,{projectId,allowedSubsidiaryIds:new Set()}),/Project not found/)
      await assert.rejects(createFieldTicket(org.orgId,actor,{projectId,date:'2026-02-30'}),/Invalid ticket date/)
      assert.equal((await db.execute<{n:number}>(sql`select count(*)::int n from field_tickets where org_id=${org.orgId}`)).rows[0]!.n,beforeTickets)
      // This week spans February into March: a regex and lexical window check
      // alone accepted the impossible February 30 date and reached a SQL cast.
      const feb = await createFieldTicket(org.orgId,actor,{projectId,date:'2027-03-01',period:'weekly'})
      const febLoaded=await loadFieldTicket(org.orgId,feb.id)
      await assert.rejects(saveCrewGrid(org.orgId,actor,feb.id,[{
        employeePartyId:employeeId,itemId:null,timeTypeId,hours:{'2027-02-30':'8'},
      }],febLoaded.revision,null),e=>e instanceof FieldTicketError)

      // The control: a valid crew row still lands.
      {
        const ticket = await ticketFor()
        await saveCrewGrid(org.orgId, actor, ticket.id, [
          { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { [day]: '8' } },
        ], ticket.revision, null)
        const rows = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from time_entries
           where org_id = ${org.orgId} and field_ticket_id = ${ticket.id}
             and employee_party_id = ${employeeId}`)).rows[0]!.n
        assert.equal(rows, 1)
      }
    } finally {
      await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`);
      await dropScratchOrg(org.orgId)
      await dropScratchOrg(alienOrg.orgId)
    }
  })
})
