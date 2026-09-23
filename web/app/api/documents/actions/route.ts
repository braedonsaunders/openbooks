import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";
import { runPostDocumentEffects } from "@openbooks/engine/src/ledger/posting-dispatch.ts";
import { getAuthz, can, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { controlDeps } from "../../../../../engine/src/ledger/document-service.ts";
import { DOC_KINDS, createPermission, postPermission } from "../../../../lib/document-kinds.ts";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { toActionFailure } from './action-failure'

export const runtime = 'nodejs'

/**
 * Submit a draft for approval, or post an approved/draft document.
 *
 * Approvals are owned by the Flows engine: submit fires the record's on_submit
 * flows. When a flow gates the document it goes pending_approval; when none
 * does, the engine records that no tenant approval policy applies and releases
 * the document to approved. Posting remains a separately permissioned action.
 */

/**
 * A pay run reaches its approvers with the working papers attached — the
 * payroll journal, the payroll register, and the run's GL preview. Only when
 * the org actually has a pay-run approval policy: without one there is no
 * approver to read them, and rendering three reports would be dead work.
 */
async function attachPayRunEvidence(
  kind: string,
  documentId: string,
  orgId: string,
  userId: string,
  allowedSubsidiaryIds?: Authz['allowedSubsidiaryIds'],
): Promise<void> {
  if (kind !== 'pay_run') return
  const { payRunApprovalState } = await import('@openbooks/engine/src/payroll/approval.ts')
  if (!(await payRunApprovalState(orgId, documentId)).policyExists) return
  const { assemblePayRunEvidence } = await import('../../../../lib/payroll-evidence')
  await assemblePayRunEvidence(orgId, userId, documentId, allowedSubsidiaryIds)
}
export async function POST(req: Request) {
  // Auth first: existence/kind/status of documents is never disclosed to
  // unauthenticated or cross-org callers.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { action?: unknown; documentId?: unknown }
  // The verb decides which permission is checked and which lifecycle path
  // runs, so it is validated as a closed set: an unrecognized action must
  // never fall through to the posting path.
  const action = body.action === 'submit' || body.action === 'post' ? body.action : null
  if (!action) return NextResponse.json({ error: "action must be 'submit' or 'post'" }, { status: 400 })
  if (typeof body.documentId !== 'string' || !body.documentId) {
    return NextResponse.json({ error: 'documentId required' }, { status: 400 })
  }
  // A malformed id can name nothing: same answer as a missing document.
  if (!isUuid(body.documentId)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, body.documentId), eq(schema.documents.orgId, user.orgId)))
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, doc.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(user.orgId, doc.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const cfg = DOC_KINDS[doc.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${doc.kind}" is not actionable here` }, { status: 422 })

  const perm = action === 'post' ? postPermission(doc.kind) : createPermission(doc.kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    if (action === 'submit') {
      if (doc.status !== 'draft') {
        return NextResponse.json({ error: `document is ${doc.status}, not draft` }, { status: 422 })
      }
      await attachPayRunEvidence(doc.kind, doc.id, user.orgId, user.id, authz.allowedSubsidiaryIds)
      // Submit/release is one command under the document row lock (same shape
      // as the posting branch below). Two concurrent submitters both pass the
      // unlocked pre-read above; without this lock the loser races the engine
      // into a raw failure instead of meeting a lifecycle refusal.
      const submission = await withOrgTransaction(user.orgId, async () => {
        const locked = (await db.execute<{ status: string }>(sql`
          select status from documents
           where id = ${doc.id} and org_id = ${user.orgId}
           for update
        `))
        const current = locked.rows[0]?.status
        if (current !== 'draft') {
          return { kind: 'invalid_status' as const, status: current ?? 'missing' }
        }
        const result = await submitAndReleaseIfUngated(doc.kind, doc.id, user.id)
        // A backup-required project invoice is approved only with its
        // substantiation packet. The gate sits after release so a gated
        // submission still reaches its approver (posting gates it again);
        // refusing here rolls the auto-release back with the transaction.
        // Dynamically imported: the packet assembler pulls PDF rendering
        // this route must not load.
        if (!result.gated && !result.flowError && doc.kind === 'customer_invoice') {
          const { requireInvoiceBackup } = await import('../../../../lib/invoice-backup')
          await requireInvoiceBackup(user.orgId, doc.id)
        }
        // The audit trail reads audit_log, and neither the auto-release nor a
        // gated submission evidences the document row there (human approvals
        // evidence through their own gate decisions), so the route records
        // the lifecycle transition itself: submit always, plus the approval
        // the auto-release performed on the submitter's behalf.
        if (!result.gated && !result.flowError) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'approved', auto_approved: true })}::jsonb, ${user.id}),
                   (${user.orgId}, 'documents', ${doc.id}, 'approve', ${JSON.stringify({ from: 'draft', to: 'approved', auto: true })}::jsonb, ${user.id})`)
        } else if (result.gated) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'pending_approval', run_id: result.runId })}::jsonb, ${user.id})`)
        }
        return { kind: 'submitted' as const, ...result }
      })
      if (submission.kind === 'invalid_status') {
        return NextResponse.json({ error: `document is ${submission.status}, not draft` }, { status: 422 })
      }
      if (submission.gated) {
        return NextResponse.json({ ok: true, requestId: submission.runId })
      }
      if (submission.flowError) {
        // An approval flow matched but errored — fail closed, never auto-approve.
        return NextResponse.json(
          { error: `approval could not be routed: ${submission.flowError}` },
          { status: 422 },
        )
      }
      return NextResponse.json({ ok: true, requestId: null, autoApproved: submission.autoApproved })
    }
    // Posting a draft submits it first, so the same evidence rule applies —
    // assembled BEFORE the transaction opens (rendering three reports inside a
    // financial transaction would hold a connection far too long).
    if (doc.status === 'draft') {
      await attachPayRunEvidence(doc.kind, doc.id, user.orgId, user.id, authz.allowedSubsidiaryIds)
    }
    // Submit/release/post is one financial command. A posting rejection must
    // not strand a draft in approved status or persist partial financial work.
    const outcome = await withOrgTransaction(user.orgId, async () => {
      const locked = (await db.execute<{ kind: string; status: string }>(sql`
        select kind, status from documents
         where id = ${doc.id} and org_id = ${user.orgId}
         for update
      `))
      const current = locked.rows[0]
      if (!current) return { kind: 'not_found' as const }
      const previousStatus = current.status
      if (previousStatus === 'draft') {
        const submission = await submitAndReleaseIfUngated(current.kind, doc.id, user.id)
        if (submission.flowError) {
          return { kind: 'flow_error' as const, error: submission.flowError }
        }
        if (submission.gated) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'pending_approval', run_id: submission.runId })}::jsonb, ${user.id})`)
          return { kind: 'pending' as const, requestId: submission.runId }
        }
        // Same lifecycle evidence as the submit branch: the auto-release the
        // direct post performs must show in the audit trail (postDocument
        // evidences the post itself through its audit option below).
        await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'approved', auto_approved: true })}::jsonb, ${user.id}),
                 (${user.orgId}, 'documents', ${doc.id}, 'approve', ${JSON.stringify({ from: 'draft', to: 'approved', auto: true })}::jsonb, ${user.id})`)
      } else if (previousStatus !== 'approved') {
        return { kind: 'invalid_status' as const, status: previousStatus }
      }
      // Issue gate after the status resolution so a mis-stated document meets
      // its own refusal first: posting a draft auto-submits it, and an
      // approved invoice may have lost its packet since. Dynamically imported:
      // the packet assembler pulls PDF rendering this route must not load.
      if (current.kind === 'customer_invoice') {
        const { requireInvoiceBackup } = await import('../../../../lib/invoice-backup')
        await requireInvoiceBackup(user.orgId, doc.id)
      }
      const entryId = await postDocument(doc.id, await controlDeps(user.orgId), {
        deferEffects: true,
        audit: { actorId: user.id, source: 'ui' },
      })
      return { kind: 'posted' as const, entryId, previousStatus }
    })
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    if (outcome.kind === 'flow_error') {
      return NextResponse.json(
        { error: `approval could not be routed: ${outcome.error}` },
        { status: 422 },
      )
    }
    if (outcome.kind === 'pending') {
      return NextResponse.json(
        { ok: true, pendingApproval: true, requestId: outcome.requestId },
        { status: 202 },
      )
    }
    if (outcome.kind === 'invalid_status') {
      return NextResponse.json(
        { error: `document is ${outcome.status}; only an approved document can be posted` },
        { status: 422 },
      )
    }
    await runPostDocumentEffects(doc.id, outcome.previousStatus)
    return NextResponse.json({ ok: true, entryId: outcome.entryId })
  } catch (e) {
    // Typed refusals (kernel rules, unconfigured control accounts, payroll
    // domain) keep their message (422) — the operator can act on them.
    // Anything else is a server defect: never echo driver text, bind params,
    // or internal ids to the user (F-t06-002 pasted a raw INSERT into the
    // page). The detail stays in the server log; the client renders its own
    // localized fallback and pins it beside the record.
    const failure = toActionFailure(e)
    if (failure.status === 500) {
      console.error('documents/actions failed', { action, documentId: body.documentId, error: e })
    }
    return NextResponse.json(failure.body, { status: failure.status })
  }
}
