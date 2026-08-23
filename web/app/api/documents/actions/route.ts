import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { ControlAccountsIncompleteError } from '@openbooks/engine/src/control-accounts.ts'
import { postDocument, PostingError, runPostDocumentEffects } from '@openbooks/engine/src/posting.ts'
import { getAuthz, can } from '../../../../lib/authz'
import { controlDeps, DOC_KINDS, createPermission, isDocKindEnabled, postPermission } from '../../../../lib/documents'

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
): Promise<void> {
  if (kind !== 'pay_run') return
  const { payRunApprovalState } = await import('@openbooks/engine/src/payroll-approval.ts')
  if (!(await payRunApprovalState(orgId, documentId)).policyExists) return
  const { assemblePayRunEvidence } = await import('../../../../lib/payroll-evidence')
  await assemblePayRunEvidence(orgId, userId, documentId)
}
export async function POST(req: Request) {
  // Auth first: existence/kind/status of documents is never disclosed to
  // unauthenticated or cross-org callers.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    action: 'submit' | 'post'
    documentId?: string
  }
  if (!body.documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 })

  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, body.documentId), eq(schema.documents.orgId, user.orgId)))
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await isDocKindEnabled(user.orgId, doc.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const cfg = DOC_KINDS[doc.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${doc.kind}" is not actionable here` }, { status: 422 })

  const perm = body.action === 'post' ? postPermission(doc.kind) : createPermission(doc.kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    if (body.action === 'submit') {
      if (doc.status !== 'draft') {
        return NextResponse.json({ error: `document is ${doc.status}, not draft` }, { status: 422 })
      }
      await attachPayRunEvidence(doc.kind, doc.id, user.orgId, user.id)
      const { gated, runId, flowError, autoApproved } =
        await submitAndReleaseIfUngated(doc.kind, doc.id, user.id)
      if (gated) {
        return NextResponse.json({ ok: true, requestId: runId })
      }
      if (flowError) {
        // An approval flow matched but errored — fail closed, never auto-approve.
        return NextResponse.json(
          { error: `approval could not be routed: ${flowError}` },
          { status: 422 },
        )
      }
      return NextResponse.json({ ok: true, requestId: null, autoApproved })
    }
    // Posting a draft submits it first, so the same evidence rule applies —
    // assembled BEFORE the transaction opens (rendering three reports inside a
    // financial transaction would hold a connection far too long).
    if (doc.status === 'draft') {
      await attachPayRunEvidence(doc.kind, doc.id, user.orgId, user.id)
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
          return { kind: 'pending' as const, requestId: submission.runId }
        }
      } else if (previousStatus !== 'approved') {
        return { kind: 'invalid_status' as const, status: previousStatus }
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
    // Posting refusals (kernel rules or unconfigured org control accounts) are
    // request-state failures, not server defects.
    const status =
      e instanceof PostingError || e instanceof ControlAccountsIncompleteError
        ? 422
        : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
