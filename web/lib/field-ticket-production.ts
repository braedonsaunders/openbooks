import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrg } from '@openbooks/engine/src/platform/db.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import { documentRevisionCounterSql } from '@openbooks/engine/src/records/revision.ts'
import { runDocumentVersionedTransaction } from '@openbooks/engine/src/records/document-edit-policy.ts'
import {
  assertProgressEnabled,
  assertQuantityMatchesBudget,
  lockProgressTask,
  parsePositiveQuantity,
  ProjectProgressError,
} from '@openbooks/engine/src/projects/progress.ts'
import { acquireFeatureGateLock } from './features'
import { subsidiaryScopeAllows } from './authz'
import { FieldTicketError, FieldTicketNotFoundError } from './field-tickets'

/**
 * Production reported on a field ticket: installed quantities per project
 * task, in the task's budget unit. Editable only while the ticket is a draft
 * (each change advances the ticket's revision, so concurrent editors
 * conflict instead of overwriting); approval records them as project
 * progress and voiding the ticket reverses that progress.
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Locked = { status: string; updatedAt: string; subsidiaryId: string | null; projectId: string | null }

async function runDraftProductionEdit(
  orgId: string,
  userId: string,
  ticketId: string,
  expectedRevision: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  edit: (tx: Transaction, locked: Locked) => Promise<void>,
): Promise<void> {
  await withOrg(orgId, async () => runDocumentVersionedTransaction<Transaction, Locked, void>({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    lock: async (tx) => (await tx.execute<Locked>(sql`
      select d.status, d.subsidiary_id as "subsidiaryId", d.project_id as "projectId",
             ${documentRevisionCounterSql(sql.raw('d.revision_seq'))} as "updatedAt"
        from documents d
        join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
       where d.id = ${ticketId} and d.org_id = ${orgId} and d.kind = 'field_ticket'
       for update of d, ft
    `)).rows[0] ?? null,
    mutate: async (tx, locked) => {
      await acquireFeatureGateLock(orgId, tx)
      if (!(await lockAndCheckOrgFeature(tx, orgId, 'fieldTickets'))) {
        throw new FieldTicketNotFoundError('Ticket not found')
      }
      if (!subsidiaryScopeAllows(allowedSubsidiaryIds, locked.subsidiaryId)) {
        throw new FieldTicketNotFoundError('Ticket not found')
      }
      await assertProgressEnabled(tx, orgId)
      if (locked.status !== 'draft') throw new FieldTicketError('Only draft tickets can be edited')
      await edit(tx, locked)
      // Advance the ticket revision so a concurrent editor's stale token conflicts.
      await tx.execute(sql`
        update documents
           set updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
               updated_by = ${userId}
         where id = ${ticketId} and org_id = ${orgId}`)
    },
  }))
}

/** Add a production quantity to a draft ticket for a task of the ticket's project. */
export async function addTicketQuantity(
  orgId: string,
  userId: string,
  ticketId: string,
  input: { projectTaskId: string; quantity: string; unit: string; note?: string | null },
  expectedRevision: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<void> {
  const quantity = parsePositiveQuantity(input.quantity)
  const note = input.note?.trim() || null
  if (note && note.length > 500) throw new FieldTicketError('Note must be 500 characters or fewer')
  await runDraftProductionEdit(orgId, userId, ticketId, expectedRevision, allowedSubsidiaryIds, async (tx, locked) => {
    if (!locked.projectId) throw new FieldTicketError('Choose a project before reporting production')
    let task: Awaited<ReturnType<typeof lockProgressTask>>
    try {
      task = await lockProgressTask(tx, orgId, locked.projectId, input.projectTaskId, null)
    } catch (error) {
      if (error instanceof ProjectProgressError && error.code === 'not-found') {
        throw new FieldTicketError('Choose a task of this ticket’s project')
      }
      throw error
    }
    assertQuantityMatchesBudget(task, input.unit)
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into field_ticket_quantities
        (org_id, field_ticket_id, project_task_id, quantity, unit, note, created_by, updated_by)
      values (${orgId}, ${ticketId}, ${task.id}, ${quantity}, ${task.budgetUnit}, ${note}, ${userId}, ${userId})
      returning id`)).rows[0]
    if (!inserted) throw new Error('production insert returned no row')
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'field_ticket_quantities', ${inserted.id}, 'insert',
              ${JSON.stringify({ after: { fieldTicketId: ticketId, projectTaskId: task.id, quantity, unit: task.budgetUnit, note } })}::jsonb,
              ${userId})`)
  })
}

/** Remove a production quantity from a draft ticket. */
export async function removeTicketQuantity(
  orgId: string,
  userId: string,
  ticketId: string,
  quantityId: string,
  expectedRevision: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<void> {
  await runDraftProductionEdit(orgId, userId, ticketId, expectedRevision, allowedSubsidiaryIds, async (tx) => {
    const removed = (await tx.execute<{ id: string; project_task_id: string; quantity: string; unit: string; note: string | null }>(sql`
      delete from field_ticket_quantities
       where id = ${quantityId} and field_ticket_id = ${ticketId} and org_id = ${orgId}
      returning id, project_task_id, quantity::text as quantity, unit, note`)).rows[0]
    if (!removed) throw new FieldTicketError('Production line not found')
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'field_ticket_quantities', ${removed.id}, 'delete',
              ${JSON.stringify({ before: { fieldTicketId: ticketId, projectTaskId: removed.project_task_id, quantity: removed.quantity, unit: removed.unit, note: removed.note } })}::jsonb,
              ${userId})`)
  })
}
