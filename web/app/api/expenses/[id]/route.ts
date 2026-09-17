import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import {
  DocumentEditError,
  documentRevisionCounterSql,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
} from '../../../../lib/documents'
import { type ExpenseEditBody, persistExpenseEdit, prepareExpenseEdit } from '../../../../lib/expense-edit'
import { loadExpenseReport } from '../../../../lib/expenses'

type RouteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const runtime = 'nodejs'

/**
 * A path segment that is not a uuid (e.g. /api/expenses/reports, which is
 * not a route) must resolve through the typed not-found contract. Without
 * this the id binds straight into a uuid comparison and PostgreSQL throws
 * 22P02, surfacing as an empty-body 500 (F-t04-015).
 */
function malformedId(id: string): NextResponse | null {
  return isUuid(id) ? null : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.read', 'expenses')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const malformed = malformedId(id)
  if (malformed) return malformed
  const report = await loadExpenseReport(id, gate.user.orgId)
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Authorize the subsidiary from the same snapshot as the returned content.
  const denied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null)
  if (denied) return denied
  return NextResponse.json(report)
}

/**
 * Autosave an expense-report draft. Approval and posted states preserve the
 * submitted evidence; corrections are represented by a separate report.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * `updated_at` token it loaded, and the write happens only when that token
 * still matches the row locked FOR UPDATE inside the same transaction — so
 * two concurrent saves can never silently overwrite one another.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  const malformedPatch = malformedId(id)
  if (malformedPatch) return malformedPatch

  const existing = (await db.execute<{ status: string; document_date: string; subsidiaryId: string | null; custom: Record<string, unknown> | null }>(
    sql`select status, document_date, subsidiary_id as "subsidiaryId", custom from documents where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}`,
  ))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, existing.rows[0].subsidiaryId)
  if (denied) return denied
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json(
      { error: `a ${existing.rows[0].status} expense report cannot be edited — create a correcting report instead` },
      { status: 422 },
    )
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as ExpenseEditBody
  // Mandatory optimistic-concurrency evidence — same contract as /api/documents/[id].
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  // Read-only validation first, so a bad body returns 4xx without a partial
  // write. Throws DocumentEditError with the same status the inline checks
  // below used to return directly.
  let prepared: Awaited<ReturnType<typeof prepareExpenseEdit>>
  try {
    prepared = await prepareExpenseEdit(body, {
      orgId: user.orgId,
      existingCustom: existing.rows[0].custom,
      existingDocumentDate: existing.rows[0].document_date,
    })
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json(
        { error: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
        { status: e.status },
      )
    }
    throw e
  }

  try {
    await runDocumentVersionedTransaction<
      RouteTransaction,
      { status: string; updatedAt: string; subsidiaryId: string | null },
      void
    >({
      expectedRevision,
      transaction: (work) => db.transaction(work),
      // The row lock and exact revision comparison are the first operations in
      // the write transaction: a concurrent writer cannot slip between the
      // check and the header/line replacement.
      lock: async (tx) => {
        const row = (await tx.execute<{ status: string; updatedAt: string; subsidiaryId: string | null }>(sql`
          select status, subsidiary_id as "subsidiaryId",
                 ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
            from documents
           where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}
           for update
        `)).rows[0]
        // Scope precedes revision comparison so a rehomed document remains
        // indistinguishable from a missing row, even with a stale token.
        return row && !guardSubsidiaryScope(gate, row.subsidiaryId) ? row : null
      },
      mutate: async (tx, locked) => {
        if (locked.status !== 'draft') {
          throw new DocumentEditError(
            422,
            `a ${locked.status} expense report cannot be edited — create a correcting report instead`,
          )
        }

        const auditBefore = await captureTransactionAuditSnapshot(tx, id, user.orgId)
        if (!auditBefore) throw new Error(`expense report ${id} disappeared before update`)

        await persistExpenseEdit(tx, {
          docId: id,
          orgId: user.orgId,
          userId: user.id,
          body: { partyId: body.partyId, paymentCardId: body.paymentCardId, documentDate: body.documentDate, memo: body.memo },
          prepared,
        })

        const auditAfter = await captureTransactionAuditSnapshot(tx, id, user.orgId)
        if (!auditAfter) throw new Error(`expense report ${id} disappeared during update`)
        await recordTransactionAudit(tx, {
          orgId: user.orgId,
          documentId: id,
          action: 'update',
          actorId: user.id,
          source: 'ui',
          before: auditBefore,
          after: auditAfter,
        })
      },
    })
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json(
        { error: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
        { status: e.status },
      )
    }
    throw e
  }

  const report = await loadExpenseReport(id, user.orgId)
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const responseDenied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null)
  if (responseDenied) return responseDenied
  return NextResponse.json(report)
}

/** Delete an expense report (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const malformedDelete = malformedId(id)
  if (malformedDelete) return malformedDelete
  const owned = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}`,
  ))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
  if (denied) return denied
  // Mandatory optimistic-concurrency evidence — same contract as the PATCH
  // verb in this file and DELETE /api/documents/[id]: a delete that lands
  // on a stale read must 409 instead of discarding another writer's draft.
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { expectedUpdatedAt?: string }
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
  try {
    await deleteDocument(id, gate.user.id, gate.user.orgId, { source: 'ui', expectedUpdatedAt: expectedRevision })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // The engine fence carries its own 409; every other refusal stays 422.
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
