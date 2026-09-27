import { apiErrorResponse } from '@/lib/api/error-response'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { submitAndReleaseIfUngated, VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE } from '@openbooks/engine/src/flows/index.ts'
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";
import { runPostDocumentEffects } from "@openbooks/engine/src/ledger/posting-dispatch.ts";
import { getAuthz, can, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { controlDeps } from "../../../../../engine/src/ledger/document-service.ts";
import { DOC_KINDS, createPermission, postPermission } from "../../../../lib/document-kinds.ts";
import { canReadDocumentKind } from "../../../../lib/flow-subject-authz.ts";
import { ApprovalRoutingError } from '../../../../lib/approval-routing-error'
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { toActionFailure } from './action-failure'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/**
 * Submit a draft for approval, post an approved/draft document, or retry a
 * stranded posting effect on a posted document.
 *
 * Approvals are owned by the Flows engine: submit fires the record's on_submit
 * flows. When a flow gates the document it goes pending_approval; when none
 * does, the engine records that no tenant approval policy applies and releases
 * the document to approved. Posting remains a separately permissioned action.
 * Retrying a terminal-failed posting effect reuses that same posting
 * permission: no new grant, so no role re-seed.
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
  const body = parsedBody.data as { action?: unknown; documentId?: unknown; reason?: unknown }
  // The verb decides which permission is checked and which lifecycle path
  // runs, so it is validated as a closed set: an unrecognized action must
  // never fall through to the posting path.
  const action = body.action === 'submit' || body.action === 'post' || body.action === 'retry-effects' ? body.action : null
  if (!action) return NextResponse.json({ error: "action must be 'submit', 'post' or 'retry-effects'" }, { status: 400 })
  if (typeof body.documentId !== 'string' || !body.documentId) {
    return NextResponse.json({ error: 'documentId required' }, { status: 400 })
  }
  // A malformed id can name nothing: same answer as a missing document.
  if (!isUuid(body.documentId)) return notFound("record")

  // Gate on the narrowest row first — kind, status and subsidiary only.
  // The full document is never loaded before the scope and permission
  // gates below have passed; the branches re-read what they need under
  // lock, with a locked scope recheck each time.
  const [doc] = await db
    .select({
      id: schema.documents.id,
      kind: schema.documents.kind,
      status: schema.documents.status,
      subsidiaryId: schema.documents.subsidiaryId,
    })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, body.documentId), eq(schema.documents.orgId, user.orgId)))
  if (!doc) return notFound("record")
  const denied = guardSubsidiaryScope(authz, doc.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(user.orgId, doc.kind))) {
    return notFound("record")
  }
  const cfg = DOC_KINDS[doc.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${doc.kind}" is not actionable here` }, { status: 422 })

  // Read before action: without the kind's read grant the record answers as
  // missing, like GET /api/documents/[id] — the 403 below stays for
  // callers who can read but may not submit/post.
  if (!canReadDocumentKind(authz, doc.kind)) {
    return notFound("record")
  }
  // Retrying a stranded effect reuses the posting grant: the operator who
  // could post the document can re-queue its cost side, and nobody new can.
  const perm = action === 'submit' ? createPermission(doc.kind) : postPermission(doc.kind)
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
        const locked = (await db.execute<{ status: string; subsidiaryId: string | null }>(sql`
          select status, subsidiary_id as "subsidiaryId" from documents
           where id = ${doc.id} and org_id = ${user.orgId}
           for update
        `))
        // Locked scope recheck: a rehome that landed after the precheck
        // must not let this transaction submit another subsidiary's record.
        if (guardSubsidiaryScope(authz, locked.rows[0]?.subsidiaryId)) {
          return { kind: 'scope_revoked' as const }
        }
        const current = locked.rows[0]?.status
        if (current !== 'draft') {
          return { kind: 'invalid_status' as const, status: current ?? 'missing' }
        }
        const result = await submitAndReleaseIfUngated(doc.kind, doc.id, user.id)
        // A refused routing throws: the submission already wrote its
        // before_submit script effects and ran its on_submit automation, and
        // answering 422 from inside this transaction would commit them
        // alongside the refusal. The catch below answers the same 422 after
        // the rollback.
        if (result.flowError) {
          throw new ApprovalRoutingError(result.flowError)
        }
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
        // the auto-release performed on the submitter's behalf. The approve
        // row carries the reason every auto-release happened without an
        // approver — no approval flow was configured for the kind.
        if (result.approvalRequired) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'draft', approval_required: true, reason: VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE })}::jsonb, ${user.id})`)
        } else if (!result.gated && !result.flowError) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'approved', auto_approved: true })}::jsonb, ${user.id}),
                   (${user.orgId}, 'documents', ${doc.id}, 'approve', ${JSON.stringify({ from: 'draft', to: 'approved', auto: true, reason: 'released without approval: no approval flow configured' })}::jsonb, ${user.id})`)
        } else if (result.gated) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'pending_approval', run_id: result.runId })}::jsonb, ${user.id})`)
        }
        return { kind: 'submitted' as const, ...result }
      })
      if (submission.kind === 'invalid_status') {
        return NextResponse.json({ error: `document is ${submission.status}, not draft` }, { status: 422 })
      }
      if (submission.kind === 'scope_revoked') {
        return notFound("record")
      }
      // A policy-refused release is answered by name: the bill stays
      // submitted (the refusal audit above stands), never released.
      if (submission.approvalRequired) {
        return NextResponse.json({ error: VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE }, { status: 422 })
      }
      if (submission.gated) {
        return NextResponse.json({ ok: true, requestId: submission.runId })
      }
      // A refused routing throws inside the transaction above (fail closed,
      // never auto-approve), so reaching here means the release succeeded.
      return NextResponse.json({ ok: true, requestId: null, autoApproved: submission.autoApproved })
    }
    if (action === 'retry-effects') {
      // The replay authorizes itself (active actor, terminal-only row) and
      // evidences the reason in audit_log, so the reason is validated before
      // any database work: a missing reason names what to supply.
      const reason = typeof body.reason === 'string' ? body.reason : ''
      if (reason.trim().length < 10 || reason.length > 1000) {
        return NextResponse.json({ error: 'a review reason of 10–1000 characters is required to retry posting effects; it is stored as the audit evidence for the replay' }, { status: 400 })
      }
      // The document gate runs under the row lock first (same shape as the
      // posting branch): the replay itself runs after, in its own
      // transaction, so the two never nest and deadlock on the same row.
      const gate = await withOrgTransaction(user.orgId, async () => {
        const locked = (await db.execute<{ status: string; subsidiaryId: string | null }>(sql`
          select status, subsidiary_id as "subsidiaryId" from documents
           where id = ${doc.id} and org_id = ${user.orgId}
           for update
        `))
        // Locked scope recheck: a rehome that landed after the precheck
        // must not let this transaction retry another subsidiary's record.
        if (guardSubsidiaryScope(authz, locked.rows[0]?.subsidiaryId)) {
          return { kind: 'scope_revoked' as const }
        }
        const current = locked.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.status !== 'posted') return { kind: 'invalid_status' as const, status: current.status }
        const effect = (await db.execute<{ id: string; status: string }>(sql`
          select id, status from posting_effects
           where document_id = ${doc.id} and org_id = ${user.orgId}
        `)).rows[0]
        // No row, or a row the worker still owns, is a refusal by name —
        // never a success for work no read can observe.
        if (!effect) return { kind: 'no_effect' as const }
        if (effect.status !== 'terminal_failed') {
          return { kind: 'not_terminal' as const, status: effect.status }
        }
        return { kind: 'replayable' as const, effectId: effect.id }
      })
      if (gate.kind === 'scope_revoked' || gate.kind === 'not_found') {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
      if (gate.kind === 'invalid_status') {
        return NextResponse.json(
          { error: `document is ${gate.status}; only a posted document's effects can be retried` },
          { status: 422 },
        )
      }
      if (gate.kind === 'no_effect') {
        return NextResponse.json({ error: 'no posting effect is recorded for this document' }, { status: 404 })
      }
      if (gate.kind === 'not_terminal') {
        return NextResponse.json(
          { error: `posting effects for this document are ${gate.status}; only a terminal-failed effect can be retried — earlier attempts still drain through the worker` },
          { status: 422 },
        )
      }
      const { replayTerminalPostingEffect, PostingEffectsReplayError } = await import('@openbooks/engine/src/ledger/posting-effects.ts')
      try {
        await replayTerminalPostingEffect({ orgId: user.orgId, id: gate.effectId, actorId: user.id, reason })
      } catch (e) {
        // The engine names the refusal (foreign row, non-terminal row,
        // inactive actor, concurrent reset); its message stays intact and
        // only the status is mapped.
        if (e instanceof PostingEffectsReplayError) {
          const missing = /was not found/.test(e.message)
          return NextResponse.json({ error: e.message }, { status: missing ? 404 : 422 })
        }
        throw e
      }
      return NextResponse.json({ ok: true })
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
      const locked = (await db.execute<{ kind: string; status: string; subsidiaryId: string | null }>(sql`
        select kind, status, subsidiary_id as "subsidiaryId" from documents
         where id = ${doc.id} and org_id = ${user.orgId}
         for update
      `))
      // Locked scope recheck: a rehome that landed after the precheck
      // must not let this transaction post another subsidiary's record.
      if (guardSubsidiaryScope(authz, locked.rows[0]?.subsidiaryId)) {
        return { kind: 'scope_revoked' as const }
      }
      const current = locked.rows[0]
      if (!current) return { kind: 'not_found' as const }
      const previousStatus = current.status
      if (previousStatus === 'draft') {
        const submission = await submitAndReleaseIfUngated(current.kind, doc.id, user.id)
        // Same rollback as the submit branch: a refused routing must not
        // commit its script effects alongside the 422.
        if (submission.flowError) {
          throw new ApprovalRoutingError(submission.flowError)
        }
        if (submission.gated) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'pending_approval', run_id: submission.runId })}::jsonb, ${user.id})`)
          return { kind: 'pending' as const, requestId: submission.runId }
        }
        // A policy-refused release refuses the whole post: nothing is
        // released and nothing posts. The refusal itself is evidenced so the
        // trail shows why the bill never moved.
        if (submission.approvalRequired) {
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'draft', approval_required: true, reason: VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE })}::jsonb, ${user.id})`)
          return { kind: 'refused' as const }
        }
        // Same lifecycle evidence as the submit branch: the auto-release the
        // direct post performs must show in the audit trail (postDocument
        // evidences the post itself through its audit option below).
        await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: 'draft', to: 'approved', auto_approved: true })}::jsonb, ${user.id}),
                 (${user.orgId}, 'documents', ${doc.id}, 'approve', ${JSON.stringify({ from: 'draft', to: 'approved', auto: true, reason: 'released without approval: no approval flow configured' })}::jsonb, ${user.id})`)
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
      return notFound("record")
    }
    if (outcome.kind === 'scope_revoked') {
      return notFound("record")
    }
    if (outcome.kind === 'pending') {
      return NextResponse.json(
        { ok: true, pendingApproval: true, requestId: outcome.requestId },
        { status: 202 },
      )
    }
    if (outcome.kind === 'refused') {
      return NextResponse.json({ error: VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE }, { status: 422 })
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
    // or internal ids to the user (a past defect pasted a raw INSERT into
    // the page). The detail stays in the server log; the client renders its own
    // localized fallback and pins it beside the record.
    // A refused approval routing already rolled back inside the transaction;
    // its message names the failed flow and the remedy, so it keeps it.
    if (e instanceof ApprovalRoutingError) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    const failure = toActionFailure(e)
    if (failure.status === 500) {
      console.error('documents/actions failed', { action, documentId: body.documentId, error: e })
    }
    return NextResponse.json(failure.body, { status: failure.status })
  }
}
