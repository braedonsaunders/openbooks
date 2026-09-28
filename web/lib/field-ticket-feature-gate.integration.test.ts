import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFieldTicket, FieldTicketNotFoundError } = await import('./field-tickets')

test('Field Ticket service refuses direct creation when Field Tickets is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-GATE', 'Field Ticket gate project', ${org.customerId}, 'active', true, '{}'::jsonb)
      `)

      await assert.rejects(
        createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null}),
        (error: unknown) => error instanceof FieldTicketNotFoundError && error.status === 404,
      )
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='field_ticket'`)).rows[0]!.n,
        0,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})


const consolidatedRows = [
  { label: "field ticket crew approved", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { addTicketLine, createFieldTicket, saveCrewGrid, loadFieldTicket, updateTicketHeader, FieldTicketError } = await import('./field-tickets')

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
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
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

              const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null})
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

        /**
         * Crew hours land as draft time entries carrying the ticket's project, and
         * item lines feed project billing — both new Projects disable-blockers. A
         * disable racing these writes must refuse one side or the other.
         */
        test('project-ticket crew and line writes refuse while Projects is disabled', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const actor = (await seedFlowActors(org.orgId)).adminId
              const timeTypeId = randomUUID()
              await db.execute(sql`insert into time_types
                (id, org_id, name, is_active, show_on_field_ticket, classification)
                values (${timeTypeId}, ${org.orgId}, 'Straight', true, true, 'regular')`)
              const employeeId = randomUUID()
              await db.execute(sql`insert into parties
                (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
                values (${employeeId}, ${org.orgId}, 'employee', 'Gated Hand', ${org.subsidiaryId}, true, '{}'::jsonb)`)
              await db.execute(sql`insert into employee_roles (party_id, org_id, is_active)
                values (${employeeId}, ${org.orgId}, true)`)
              const projectId = randomUUID()
              await db.execute(sql`insert into projects
                (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'GATED', 'Gated job',
                        ${org.customerId}, 'active', true, '{}'::jsonb)`)
              const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null})
              // Reads hide with the gate, so capture the revision token and window
              // day before disabling.
              const loaded = await loadFieldTicket(org.orgId, created.id)
              await db.execute(sql`update orgs set settings = jsonb_set(settings,'{features,projects}','false'::jsonb) where id = ${org.orgId}`)

              const day = loaded.fieldTicket.periodStart
              await assert.rejects(
                saveCrewGrid(org.orgId, actor, created.id, [
                  { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { [day]: '8' } },
                ], loaded.revision, null),
                (e) => e instanceof FieldTicketError && e.message === 'Projects feature is disabled',
              )
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from time_entries
                  where org_id = ${org.orgId} and field_ticket_id = ${created.id}`)).rows[0]!.n,
                0,
                'the refused grid stores no crew hours',
              )

              await assert.rejects(
                addTicketLine(org.orgId, actor, created.id, { itemId: org.items.service, quantity: '1' }, loaded.revision, null),
                (e) => e instanceof FieldTicketError && e.message === 'Projects feature is disabled',
              )
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from document_lines
                  where org_id = ${org.orgId} and document_id = ${created.id}`)).rows[0]!.n,
                0,
                'the refused add stores no item line',
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })

        test('re-homing a ticket onto a project refuses while Projects is disabled', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const actor = (await seedFlowActors(org.orgId)).adminId
              const firstId = randomUUID(), secondId = randomUUID()
              for (const [id, code] of [[firstId, 'FIRST'], [secondId, 'SECOND']] as const) {
                await db.execute(sql`insert into projects
                  (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                  values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${code}, ${org.customerId}, 'active', true, '{}'::jsonb)`)
              }
              const created = await createFieldTicket(org.orgId, actor, { projectId: firstId, allowedSubsidiaryIds: null})
              const revision = (await loadFieldTicket(org.orgId, created.id)).revision
              await db.execute(sql`update orgs set settings = jsonb_set(settings,'{features,projects}','false'::jsonb) where id = ${org.orgId}`)
              await assert.rejects(
                updateTicketHeader(org.orgId, actor, created.id, { projectId: secondId }, revision, null),
                (e) => e instanceof FieldTicketError && e.message === 'Projects feature is disabled',
              )
              assert.equal(
                (await db.execute<{ project_id: string }>(sql`select project_id from documents
                  where org_id = ${org.orgId} and id = ${created.id}`)).rows[0]!.project_id,
                firstId,
                'the refused re-home keeps the original project',
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "field ticket header date", register: async () => {
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { createFieldTicket, loadFieldTicket, updateTicketHeader, FieldTicketError } = await import('./field-tickets')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * The header form forwards any shape-valid documentDate to the ticket update.
         * An impossible calendar day (2026-02-30) must fail closed as a domain error
         * before any write — not reach the DATE column and surface as a 500 from
         * PostgreSQL.
         */
        test('the ticket header refuses an impossible document date', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
              const actor = (await seedFlowActors(org.orgId)).adminId
              const projectId = randomUUID()
              await db.execute(sql`insert into projects
                (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'HDR-DATE', 'Header date job',
                        ${org.customerId}, 'active', true, '{}'::jsonb)`)

              const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null})
              const loaded = await loadFieldTicket(org.orgId, created.id)

              await assert.rejects(
                updateTicketHeader(org.orgId, actor, created.id, { documentDate: '2026-02-30' }, loaded.revision, null),
                (e) => e instanceof FieldTicketError && /Invalid ticket date/.test(e.message),
              )
              const after = await loadFieldTicket(org.orgId, created.id)
              assert.equal(after.documentDate, loaded.documentDate)
              assert.equal(after.revision, loaded.revision)

              // A real calendar day still saves.
              await updateTicketHeader(org.orgId, actor, created.id, { documentDate: '2026-02-27' }, after.revision, null)
              assert.equal((await loadFieldTicket(org.orgId, created.id)).documentDate, '2026-02-27')
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
  { label: "field ticket crew ownership", register: async () => {
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

              const day = (await loadFieldTicket(org.orgId, (await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null})).id)).fieldTicket.periodStart
              const ticketFor = async () => {
                const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null})
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
              await assert.rejects(createFieldTicket(org.orgId,actor,{projectId,date:'2026-02-30', allowedSubsidiaryIds: null}),/Invalid ticket date/)
              assert.equal((await db.execute<{n:number}>(sql`select count(*)::int n from field_tickets where org_id=${org.orgId}`)).rows[0]!.n,beforeTickets)
              // This week spans February into March: a regex and lexical window check
              // alone accepted the impossible February 30 date and reached a SQL cast.
              const feb = await createFieldTicket(org.orgId,actor,{projectId,date:'2027-03-01',period:'weekly', allowedSubsidiaryIds: null})
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
  } },
] as const;

for (const row of consolidatedRows) await row.register();
