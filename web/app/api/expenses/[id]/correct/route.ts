import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/ledger/document-void.ts'
import { can, guardSubsidiaryScope } from '../../../../../lib/authz'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { DocumentEditError, requireDocumentEditRevision, validateCorrectionReason } from "../../../../../../engine/src/records/document-edit-policy.ts";
import { type ExpenseCorrectionBody, createExpenseCorrectionDraft } from '../../../../../lib/expense-edit'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Correct a posted expense report — the expense half of the documents
 * correct contract (POST /api/documents/[id]/correct), in expense
 * vocabulary. The replacement draft starts as a faithful copy of the
 * posted source with the submitted edit body applied, and the source is
 * voided under control, atomically: a void that fails for any reason rolls
 * the replacement and its lineage back with it.
 *
 * Expense reports are absent from the generic DOC_KINDS map (they keep
 * their own drawer, edit validation, and permissions), so the generic
 * route answers 422 for them — this route is their dedicated correction
 * workflow.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const found = (await db.execute<{
    status: string
    subsidiaryId: string | null
    custom: Record<string, unknown> | null
    documentDate: string
  }>(sql`
    select status, subsidiary_id as "subsidiaryId", custom,
           document_date as "documentDate"
      from documents
     where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}
  `))
  const source = found.rows[0]
  if (!source) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, source.subsidiaryId)
  if (denied) return denied
  if (!can(gate, 'expenses.create')) {
    return NextResponse.json({ error: 'missing permission: expenses.create' }, { status: 403 })
  }
  if (!can(gate, 'ap.post')) {
    return NextResponse.json({ error: 'missing permission: ap.post' }, { status: 403 })
  }
  if (source.status !== 'posted') {
    return NextResponse.json({ error: 'only a posted expense report can be corrected' }, { status: 422 })
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as ExpenseCorrectionBody
  try {
    requireDocumentEditRevision(body.expectedUpdatedAt)
    validateCorrectionReason(body.amendmentReason)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
  let outcome: {
    replacement: { id: string; documentNumber: string }
    result: { status: 'voided' | 'pending_approval'; runId: string | null }
  }
  try {
    // The replacement draft (and its mandatory `reverses` evidence) plus the
    // source's controlled void are one atomic unit — the same guarantee as
    // POST /api/documents/[id]/correct. Correction drafts are flow-silent
    // until submitted (expense drafts never run on_create flows), so unlike
    // the generic contract there is no post-commit flow dispatch here; the
    // replacement runs its on_submit flows when it is submitted.
    outcome = await withOrgTransaction(user.orgId, async () => {
      const replacement = await createExpenseCorrectionDraft(id, body, {
        orgId: user.orgId,
        userId: user.id,
      })
      const result = await requestDocumentVoid({
        documentId: id,
        orgId: user.orgId,
        actorId: user.id,
        reason: (body.amendmentReason ?? '').trim(),
        source: 'ui',
        expectedUpdatedAt: body.expectedUpdatedAt,
      })
      return { replacement, result }
    })
    return NextResponse.json(
      {
        ok: true,
        correctionId: outcome.replacement.id,
        correctionNumber: outcome.replacement.documentNumber,
        voidStatus: outcome.result.status,
        requestId: outcome.result.runId,
      },
      { status: outcome.result.status === 'pending_approval' ? 202 : 201 },
    )
  } catch (error) {
    if (error instanceof DocumentEditError || error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
