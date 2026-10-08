import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { db, withBypassContext, withOrgTransaction } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { requestDocumentVoid } = await import('@openbooks/engine/src/ledger/document-void.ts')
const { ProjectProgressError, recordFieldTicketProgressInTransaction } = await import('@openbooks/engine/src/projects/progress.ts')
const { createFieldTicket, loadFieldTicket, releaseFieldTicketApproval, saveCrewGrid, submitFieldTicket, FieldTicketError } = await import('./field-tickets')
const { addTicketQuantity, removeTicketQuantity } = await import('./field-ticket-production')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

async function progressRows(orgId: string, ticketId: string) {
  return (await db.execute<{ quantity: string; unit: string; entry_date: string; reverses_entry_id: string | null }>(sql`
    select quantity::text as quantity, unit, entry_date::text as entry_date, reverses_entry_id
      from project_progress_entries
     where org_id = ${orgId} and source = 'field_ticket' and source_document_id = ${ticketId}
     order by created_at, id`)).rows
}

test('approved field-ticket production becomes progress exactly once and voiding the ticket reverses it', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
        features: { projects: true, fieldTickets: true, projectProgress: true },
      })}::jsonb where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID(), taskId = randomUUID(), unbudgeted = randomUUID(), employeeId = randomUUID(), timeTypeId = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-PROD', 'Production job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into project_tasks (id, org_id, project_id, code, name, estimated_cost, budget_quantity, budget_unit)
        values (${taskId}, ${org.orgId}, ${projectId}, '100', 'Conduit', 1000, 100, 'm'),
               (${unbudgeted}, ${org.orgId}, ${projectId}, '200', 'Cleanup', 100, null, null)`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Crew Hand', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into employee_roles (party_id, org_id, is_active) values (${employeeId}, ${org.orgId}, true)`)
      await db.execute(sql`insert into time_types (id, org_id, name, is_active, show_on_field_ticket, classification)
        values (${timeTypeId}, ${org.orgId}, 'Straight', true, true, 'regular')`)

      const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null })
      let ticket = await loadFieldTicket(org.orgId, created.id)
      await saveCrewGrid(org.orgId, actor, created.id, [
        { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { [ticket.fieldTicket.periodStart]: '8' } },
      ], ticket.revision, null)

      ticket = await loadFieldTicket(org.orgId, created.id)
      await assert.rejects(
        addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: taskId, quantity: '5', unit: 'ft' }, ticket.revision),
        (error: unknown) => error instanceof ProjectProgressError && error.code === 'unit-mismatch',
      )
      await assert.rejects(
        addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: unbudgeted, quantity: '1', unit: 'ea' }, ticket.revision),
        (error: unknown) => error instanceof ProjectProgressError && error.code === 'no-budget-quantity',
      )
      await addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: taskId, quantity: '12.5', unit: 'm', note: 'North run' }, ticket.revision)
      // The add advanced the revision: the stale token now conflicts.
      await assert.rejects(addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: taskId, quantity: '1', unit: 'm' }, ticket.revision))
      ticket = await loadFieldTicket(org.orgId, created.id)
      await addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: taskId, quantity: '2', unit: 'm' }, ticket.revision)
      ticket = await loadFieldTicket(org.orgId, created.id)
      const extra = ticket.production.find((row) => row.quantity === '2.00000000')!
      await removeTicketQuantity(org.orgId, actor, created.id, extra.id, ticket.revision)
      ticket = await loadFieldTicket(org.orgId, created.id)
      assert.deepEqual(ticket.production.map((row) => [row.quantity, row.unit, row.note]), [['12.50000000', 'm', 'North run']])

      await submitFieldTicket(org.orgId, actor, created.id)
      ticket = await loadFieldTicket(org.orgId, created.id)
      assert.equal(ticket.status, 'approved')
      assert.deepEqual(await progressRows(org.orgId, created.id), [
        { quantity: '12.50000000', unit: 'm', entry_date: ticket.fieldTicket.periodEnd, reverses_entry_id: null },
      ])

      // A repeated release and a direct replay both record nothing more.
      await withOrgTransaction(org.orgId, () => releaseFieldTicketApproval(org.orgId, actor, created.id, 'approved', null))
      const replay = await withOrgTransaction(org.orgId, () => recordFieldTicketProgressInTransaction(db, {
        orgId: org.orgId, actorId: actor, ticketId: created.id, projectId, entryDate: ticket.fieldTicket.periodEnd,
      }))
      assert.deepEqual(replay, { recorded: 0, alreadyRecorded: true })
      assert.equal((await progressRows(org.orgId, created.id)).length, 1)

      // Production is frozen once the ticket leaves draft.
      await assert.rejects(
        addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: taskId, quantity: '1', unit: 'm' }, ticket.revision),
        (error: unknown) => error instanceof FieldTicketError || (error as { status?: number }).status === 409,
      )

      const voided = await requestDocumentVoid({ documentId: created.id, orgId: org.orgId, actorId: actor, reason: 'Duplicate ticket' })
      assert.equal(voided.status === 'pending_approval', false)
      const rows = await progressRows(org.orgId, created.id)
      assert.equal(rows.length, 2)
      assert.equal(rows[1]!.quantity, '-12.50000000')
      assert.ok(rows[1]!.reverses_entry_id)
      const net = (await db.execute<{ net: string }>(sql`
        select coalesce(sum(quantity), 0)::text as net from project_progress_entries
         where org_id = ${org.orgId} and project_task_id = ${taskId}`)).rows[0]!.net
      assert.equal(Number(net), 0)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

test('a ticket reporting production cannot be submitted while Progress tracking is off', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
        features: { projects: true, fieldTickets: true, projectProgress: true },
      })}::jsonb where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID(), taskId = randomUUID(), employeeId = randomUUID(), timeTypeId = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-OFF', 'Gate job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into project_tasks (id, org_id, project_id, name, budget_quantity, budget_unit)
        values (${taskId}, ${org.orgId}, ${projectId}, 'Conduit', 100, 'm')`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Crew Hand', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into employee_roles (party_id, org_id, is_active) values (${employeeId}, ${org.orgId}, true)`)
      await db.execute(sql`insert into time_types (id, org_id, name, is_active, show_on_field_ticket, classification)
        values (${timeTypeId}, ${org.orgId}, 'Straight', true, true, 'regular')`)
      const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null })
      let ticket = await loadFieldTicket(org.orgId, created.id)
      await saveCrewGrid(org.orgId, actor, created.id, [
        { employeePartyId: employeeId, itemId: null, timeTypeId, hours: { [ticket.fieldTicket.periodStart]: '8' } },
      ], ticket.revision, null)
      ticket = await loadFieldTicket(org.orgId, created.id)
      await addTicketQuantity(org.orgId, actor, created.id, { projectTaskId: taskId, quantity: '3', unit: 'm' }, ticket.revision)

      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projectProgress}', 'false'::jsonb) where id = ${org.orgId}`)
      await assert.rejects(submitFieldTicket(org.orgId, actor, created.id), (error: unknown) =>
        error instanceof FieldTicketError && /Progress tracking is off/.test(error.message))
      assert.equal((await loadFieldTicket(org.orgId, created.id)).status, 'draft')
      assert.equal((await progressRows(org.orgId, created.id)).length, 0)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
