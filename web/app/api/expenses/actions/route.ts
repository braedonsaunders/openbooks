import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { SubmitError, submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import {
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from '@openbooks/engine/src/records/control-accounts.ts'
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";
import { PostingError } from "@openbooks/engine/src/ledger/posting-contracts.ts";
import { can, getAuthz, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { DocumentEditError, requireDocumentEditRevision } from "../../../../../engine/src/records/document-edit-policy.ts";
import { documentRevisionCounterSql } from "../../../../../engine/src/records/revision.ts";
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Expense report lifecycle: draft → submit (Flows approval) → approved → post.
 * Per-action permission gates: submit = expenses.create, post = ap.post,
 * recall = expenses.create plus submitter-or-admin on the report.
 * Approval decisions are owned by the Flows engine (via the /inbox worklist
 * and the record flyout → /api/flows/gates/decide), not this route.
 */

/**
 * The document must be an expense report in the caller's org AND inside the
 * caller's subsidiary scope — submit and post both resolve through here, so a
 * restricted caller can never route an out-of-scope report to the GL.
 */
async function expenseReport(id: string, authz: Authz) {
  // A malformed id would surface as a Postgres uuid throw and a raw 500;
  // resolve it through the same not-found contract as an unknown id.
  if (!isUuid(id)) return null
  const r = (await db.execute<{ id: string; status: string; subsidiaryId: string | null }>(
    sql`select id, status, subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = 'expense_report' and org_id = ${authz.user.orgId}`,
  ))
  const row = r.rows[0]
  if (!row) return null
  return guardSubsidiaryScope(authz, row.subsidiaryId) ? null : row
}

/**
 * Recall a submitted or approved-but-unposted expense report to draft,
 * cancelling its open approval gates and runs. Decided gates stand as
 * history; only open ('pending'/'escalated') gates and live
 * ('running'/'waiting') runs are cancelled, so a concurrent approver either
 * wins first (their decision persists as evidence) or fails closed on the
 * cancelled gate ("already resolved"). Only the submitter (or document
 * author for legacy rows) or an org admin may recall.
 */
async function recallExpenseReport(input: {
  documentId: string
  orgId: string
  actorId: string
  expectedUpdatedAt: unknown
  isAdmin: boolean
}): Promise<{ cancelledGates: number; cancelledRuns: number }> {
  const expectedRevision = requireDocumentEditRevision(input.expectedUpdatedAt)
  return withOrgTransaction(input.orgId, async () => {
    const locked = (await db.execute<{
      status: string
      submittedBy: string | null
      createdBy: string | null
      voidRequestedAt: string | null
      revision: string
    }>(sql`
      select status, submitted_by as "submittedBy", created_by as "createdBy",
             void_requested_at as "voidRequestedAt",
             ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "revision"
        from documents
       where id = ${input.documentId} and kind = 'expense_report' and org_id = ${input.orgId}
       for update
    `)).rows[0]
    if (!locked) throw new DocumentEditError(404, 'expense report not found')
    if (locked.status !== 'pending_approval' && locked.status !== 'approved') {
      throw new DocumentEditError(
        422,
        `expense report is ${locked.status}; only a submitted or approved report can be recalled to draft`,
      )
    }
    if (locked.voidRequestedAt) {
      throw new DocumentEditError(422, 'a void is already in flight for this report — complete it first')
    }
    if (expectedRevision !== locked.revision) {
      throw new DocumentEditError(409, 'this document changed after you opened it; reload and review the latest revision')
    }
    // The document author recalls only legacy rows that were never submitted
    // through this flow (no recorded submitter). Once a submitter exists, the
    // creator — who may be a different person (e.g. an assistant who drafted
    // for someone else) — must not be able to pull another user's submission
    // back to draft.
    const isSubmitter =
      locked.submittedBy === input.actorId ||
      (locked.submittedBy == null && locked.createdBy === input.actorId)
    if (!isSubmitter && !input.isAdmin) {
      throw new DocumentEditError(403, 'only the submitter or an admin can recall this report to draft')
    }
    const gates = (await db.execute<{ id: string }>(sql`
      update flow_gates
         set status = 'cancelled', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and subject_kind = 'expense_report' and subject_id = ${input.documentId}
         and status in ('pending', 'escalated')
      returning id
    `)).rows
    const runs = (await db.execute<{ id: string }>(sql`
      update flow_runs
         set status = 'cancelled', finished_at = now(), error = 'recalled to draft',
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and subject_kind = 'expense_report' and subject_id = ${input.documentId}
         and status in ('running', 'waiting')
      returning id
    `)).rows
    await db.execute(sql`
      update documents
         set status = 'draft',
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${input.actorId}
       where id = ${input.documentId} and org_id = ${input.orgId}
    `)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${input.orgId}, 'documents', ${input.documentId}, 'update',
        ${JSON.stringify({
          mode: 'approval_recall',
          before: { status: locked.status },
          after: { status: 'draft' },
          cancelledGates: gates.length,
          cancelledRuns: runs.length,
        })}::jsonb,
        ${input.actorId}, 'ui'
      )
    `)
    return { cancelledGates: gates.length, cancelledRuns: runs.length }
  })
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user
  // This route resolves authz itself rather than through guardPermission (the
  // permission differs per action), so it carries the feature gate inline. A
  // disabled module must not keep a submit/post path open. 404, not 403 — an
  // off feature is indistinguishable from an absent API.
  if (!(await isFeatureEnabled(user.orgId, 'expenses'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    action: 'submit' | 'post' | 'recall'
    documentId?: string
    expectedUpdatedAt?: string
  }

  try {
    switch (body.action) {
      case 'submit': {
        if (!can(authz, 'expenses.create')) {
          return NextResponse.json({ error: 'missing permission: expenses.create' }, { status: 403 })
        }
        if (!body.documentId || !(await expenseReport(body.documentId, authz))) {
          return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        }
        const { runId, flowError, autoApproved } =
          await submitAndReleaseIfUngated('expense_report', body.documentId, user.id)
        if (flowError) {
          return NextResponse.json(
            { error: `approval could not be routed: ${flowError}` },
            { status: 422 },
          )
        }
        return NextResponse.json({ ok: true, requestId: runId, autoApproved })
      }
      case 'post': {
        if (!can(authz, 'ap.post')) {
          return NextResponse.json({ error: 'missing permission: ap.post' }, { status: 403 })
        }
        if (!body.documentId) {
          return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        }
        const expense = await expenseReport(body.documentId, authz)
        if (!expense) return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        if (expense.status !== 'approved') {
          return NextResponse.json(
            { error: `expense report is ${expense.status}; only an approved report can be posted` },
            { status: 422 },
          )
        }
        const deps = { control: await loadRequiredControlAccounts(user.orgId) }
        const entryId = await postDocument(body.documentId, deps, {
          audit: { actorId: user.id, source: 'ui' },
        })
        return NextResponse.json({ ok: true, entryId })
      }
      case 'recall': {
        if (!can(authz, 'expenses.create')) {
          return NextResponse.json({ error: 'missing permission: expenses.create' }, { status: 403 })
        }
        if (!body.documentId || !(await expenseReport(body.documentId, authz))) {
          return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        }
        try {
          const outcome = await recallExpenseReport({
            documentId: body.documentId,
            orgId: user.orgId,
            actorId: user.id,
            expectedUpdatedAt: body.expectedUpdatedAt,
            isAdmin: user.isSuperAdmin || user.roles.some((role) => role.key === 'admin'),
          })
          return NextResponse.json({ ok: true, ...outcome })
        } catch (e) {
          if (e instanceof DocumentEditError) {
            return NextResponse.json({ error: e.message }, { status: e.status })
          }
          throw e
        }
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    // Posting refusals (kernel rules or unconfigured org control accounts)
    // and submission lifecycle refusals (a double-clicked or replayed submit
    // on a report that already left draft) are request-state failures, not
    // server defects. Revision-fence refusals carry their own status.
    const status =
      e instanceof PostingError || e instanceof ControlAccountsIncompleteError || e instanceof SubmitError
        ? 422
        : e instanceof DocumentEditError
          ? e.status
          : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
