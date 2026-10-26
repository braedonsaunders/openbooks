import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  returnDocumentToDraft,
  ReturnToDraftError,
  submitAndReleaseIfUngated,
  withdrawDocumentSubmission,
  WithdrawSubmissionError,
} from "@openbooks/engine/flows/module";
import { documentKindPermissions } from "@openbooks/engine/records/document-kind-permissions";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { runPostDocumentEffects } from "@openbooks/engine/ledger/posting-dispatch";
import { getAuthz, can, guardSubsidiaryScope, type Authz } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { controlDeps } from "@openbooks/engine/ledger/document-service";
import { DOC_KINDS, createPermission, postPermission } from "../../../../lib/document-kinds.ts";
import { canReadDocumentKind, holdsSubjectGrant } from "../../../../lib/flow-subject-authz.ts";
import { ApprovalRoutingError } from "../../../../lib/approval-routing-error";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { toActionFailure } from "./action-failure";
import { notFound, postingRefusal } from "@/lib/api/responses";
import { partylessControlLines } from "../../../../lib/journal-warnings";
const POSTBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), documentId: uuidString() }),
  z.object({ action: z.literal("post"), documentId: uuidString() }),
  z.object({
    action: z.literal("return_to_draft"),
    documentId: uuidString(),
    reason: z
      .string()
      .trim()
      .min(5, "a return reason between 5 and 500 characters is required")
      .max(500),
    expectedUpdatedAt: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("withdraw"),
    documentId: uuidString(),
    reason: z
      .string()
      .trim()
      .min(5, "a withdrawal reason between 5 and 500 characters is required")
      .max(500),
    expectedUpdatedAt: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("retry-effects"),
    documentId: uuidString(),
    reason: z
      .string()
      .max(1000, "A 10–1000 character review reason is required to retry posting effects")
      .refine(
        (reason) => reason.trim().length >= 10,
        "A 10–1000 character review reason is required to retry posting effects",
      ),
  }),
]);

export const runtime = "nodejs";

/**
 * Submit a draft for approval, post an approved/draft document, return an
 * approved never-posted document to draft, or retry a stranded posting
 * effect on a posted document.
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
  allowedSubsidiaryIds?: Authz["allowedSubsidiaryIds"],
): Promise<void> {
  if (kind !== "pay_run") return;
  const { payRunApprovalState } = await import("@openbooks/engine/payroll/approval");
  if (!(await payRunApprovalState(orgId, documentId)).policyExists) return;
  const { assemblePayRunEvidence } = await import("../../../../lib/payroll-evidence");
  await assemblePayRunEvidence(orgId, userId, documentId, allowedSubsidiaryIds);
}
export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema,
  handler: async ({ request: _req, body: routeBody }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;

    const body = routeBody;
    const action = body.action;
    if (!isUuid(body.documentId)) return notFound("record");
    const [doc] = await db
      .select({
        id: schema.documents.id,
        kind: schema.documents.kind,
        status: schema.documents.status,
        subsidiaryId: schema.documents.subsidiaryId,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, body.documentId), eq(schema.documents.orgId, user.orgId)));
    if (!doc) return notFound("record");
    const denied = guardSubsidiaryScope(authz, doc.subsidiaryId);
    if (denied) return denied;
    if (!(await isDocKindEnabled(user.orgId, doc.kind))) {
      return notFound("record");
    }
    const cfg = DOC_KINDS[doc.kind];
    // Withdrawal recalls a pending submission through the kind-agnostic
    // withdraw service, so every kind with a Flows permission mapping
    // (quotes, sales and purchase orders, and the registry kinds) withdraws
    // here. Every other action stays on the document registry.
    const withdrawable = action === "withdraw" && documentKindPermissions(doc.kind) !== null;
    if (!cfg && !withdrawable) {
      return NextResponse.json(
        { error: `kind "${doc.kind}" is not actionable here` },
        { status: 422 },
      );
    }
    // A self-service holder withdraws only their own submission: the
    // record-level grant reaches their own expense report and nothing else.
    const ownWithdrawal =
      action === "withdraw" &&
      !canReadDocumentKind(authz, doc.kind) &&
      (await holdsSubjectGrant(
        authz,
        doc.kind,
        doc.id,
        documentKindPermissions(doc.kind)?.read ?? "",
      ));
    if (!canReadDocumentKind(authz, doc.kind) && !ownWithdrawal) {
      return notFound("record");
    }
    // Return-to-draft undoes an approval, so it requires the same
    // authority as approving the kind — never just the edit grant.
    // Withdraw recalls the submitter's own pending request, so the submit
    // grant suffices — but the service still demands the caller be the
    // submitter unless they hold the approve grant.
    const kindPerms = documentKindPermissions(doc.kind);
    const approvePerm = kindPerms?.approve ?? postPermission(doc.kind);
    // The registry namespace helper throws for non-registry kinds, so a
    // order withdrawing here resolves its submit grant from the
    // same permission table instead; registry kinds keep their helper.
    const submitPerm =
      kindPerms && !DOC_KINDS[doc.kind] ? kindPerms.edit : createPermission(doc.kind);
    if (action === "withdraw") {
      if (
        !(await holdsSubjectGrant(authz, doc.kind, doc.id, submitPerm)) &&
        !can(authz, approvePerm)
      ) {
        return NextResponse.json({ error: `missing permission: ${submitPerm}` }, { status: 403 });
      }
    } else {
      const perm =
        action === "submit"
          ? submitPerm
          : action === "return_to_draft"
            ? approvePerm
            : postPermission(doc.kind);
      if (!can(authz, perm)) {
        return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 });
      }
    }
    try {
      if (action === "submit") {
        if (doc.status !== "draft") {
          return NextResponse.json(
            { error: `document is ${doc.status}, not draft` },
            { status: 422 },
          );
        }
        await attachPayRunEvidence(
          doc.kind,
          doc.id,
          user.orgId,
          user.id,
          authz.allowedSubsidiaryIds,
        );
        // Submit/release is one command under the document row lock (same shape
        // as the posting branch below). Two concurrent submitters both pass the
        // unlocked pre-read above; without this lock the loser races the engine
        // into a raw failure instead of meeting a lifecycle refusal.
        const submission = await withOrgTransaction(user.orgId, async () => {
          const locked = await db.execute<{ status: string; subsidiaryId: string | null }>(
            sql`
              select status, subsidiary_id as "subsidiaryId" from documents
               where id = ${doc.id} and org_id = ${user.orgId}
               for update
            `,
            "objects",
          );
          // Locked scope recheck: a rehome that landed after the precheck
          // must not let this transaction submit another subsidiary's record.
          if (guardSubsidiaryScope(authz, locked[0]?.subsidiaryId)) {
            return { kind: "scope_revoked" as const };
          }
          const current = locked[0]?.status;
          if (current !== "draft") {
            return { kind: "invalid_status" as const, status: current ?? "missing" };
          }
          const result = await submitAndReleaseIfUngated(doc.kind, doc.id, user.id);
          // A refused routing throws: the submission already wrote its
          // before_submit script effects and ran its on_submit automation, and
          // answering 422 from inside this transaction would commit them
          // alongside the refusal. The catch below answers the same 422 after
          // the rollback.
          if (result.flowError) {
            throw new ApprovalRoutingError(result.flowError);
          }
          // A backup-required project invoice is approved only with its
          // substantiation packet. The gate sits after release so a gated
          // submission still reaches its approver (posting gates it again);
          // refusing here rolls the auto-release back with the transaction.
          // Dynamically imported: the packet assembler pulls PDF rendering
          // this route must not load.
          if (!result.gated && !result.flowError && doc.kind === "customer_invoice") {
            const { requireInvoiceBackup } = await import("../../../../lib/invoice-backup");
            await requireInvoiceBackup(user.orgId, doc.id);
          }
          // The audit trail reads audit_log, and neither the auto-release nor a
          // gated submission evidences the document row there (human approvals
          // evidence through their own gate decisions), so the route records
          // the lifecycle transition itself: submit always, plus the approval
          // the auto-release performed on the submitter's behalf. The approve
          // row carries the reason every auto-release happened without an
          // approver — no approval flow was configured for the kind.
          if (!result.gated && !result.flowError) {
            await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
                values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: "draft", to: "approved", auto_approved: true })}::jsonb, ${user.id}),
                       (${user.orgId}, 'documents', ${doc.id}, 'approve', ${JSON.stringify({ from: "draft", to: "approved", auto: true, reason: "released without approval: no applicable Flow approval gates" })}::jsonb, ${user.id})`);
          } else if (result.gated) {
            await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
                values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: "draft", to: "pending_approval", run_id: result.runId })}::jsonb, ${user.id})`);
          }
          return { kind: "submitted" as const, ...result };
        });
        if (submission.kind === "invalid_status") {
          return NextResponse.json(
            { error: `document is ${submission.status}, not draft` },
            { status: 422 },
          );
        }
        if (submission.kind === "scope_revoked") {
          return notFound("record");
        }
        if (submission.gated) {
          return NextResponse.json({ ok: true, requestId: submission.runId });
        }
        // A refused routing throws inside the transaction above (fail closed,
        // never auto-approve), so reaching here means the release succeeded.
        return NextResponse.json({
          ok: true,
          requestId: null,
          autoApproved: submission.autoApproved,
        });
      }
      if (action === "return_to_draft") {
        // Return the approved, never-posted document to draft under the
        // row lock (same shape as the submit/post branches): a rehome
        // that landed after the precheck meets the uniform 404, and the
        // service owns the status, scope, revision, and application
        // preconditions with named remedies. A concurrent post either
        // wins first (the service refuses) or loses its approved
        // precondition against the flipped row — exactly one converges.
        try {
          const outcome = await withOrgTransaction(user.orgId, async () => {
            const locked = await db.execute<{ status: string; subsidiaryId: string | null }>(
              sql`
                select status, subsidiary_id as "subsidiaryId" from documents
                 where id = ${doc.id} and org_id = ${user.orgId}
                 for update
              `,
              "objects",
            );
            if (guardSubsidiaryScope(authz, locked[0]?.subsidiaryId)) {
              return { kind: "scope_revoked" as const };
            }
            if (!locked[0]) return { kind: "not_found" as const };
            const result = await returnDocumentToDraft({
              documentId: doc.id,
              orgId: user.orgId,
              actorId: user.id,
              reason: body.reason,
              expectedUpdatedAt: body.expectedUpdatedAt,
              allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
            });
            return { kind: "returned" as const, result };
          });
          if (outcome.kind === "scope_revoked" || outcome.kind === "not_found") {
            return notFound("record");
          }
          return NextResponse.json({ ok: true, supersededRunIds: outcome.result.supersededRunIds });
        } catch (e) {
          if (e instanceof ScopeNotFoundError) return notFound("record");
          if (e instanceof ReturnToDraftError) {
            return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
          }
          throw e;
        }
      }
      if (action === "withdraw") {
        try {
          const result = await withdrawDocumentSubmission({
            documentId: doc.id,
            orgId: user.orgId,
            actorId: user.id,
            actorIsApprover: can(authz, approvePerm),
            reason: body.reason,
            expectedUpdatedAt: body.expectedUpdatedAt,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          });
          return NextResponse.json(result);
        } catch (error) {
          if (error instanceof ScopeNotFoundError)
            return NextResponse.json({ error: "document not found" }, { status: 404 });
          if (error instanceof WithdrawSubmissionError) {
            return NextResponse.json(
              { error: error.message, code: error.code },
              { status: error.status },
            );
          }
          throw error;
        }
      }

      if (action === "retry-effects") {
        const reason = body.reason;
        const gate = await withOrgTransaction(user.orgId, async () => {
          const locked = await db.execute<{ status: string; subsidiaryId: string | null }>(
            sql`
              select status, subsidiary_id as "subsidiaryId" from documents
               where id = ${doc.id} and org_id = ${user.orgId}
               for update
            `,
            "objects",
          );
          if (guardSubsidiaryScope(authz, locked[0]?.subsidiaryId)) {
            return { kind: "scope_revoked" as const };
          }
          const current = locked[0];
          if (!current) return { kind: "not_found" as const };
          if (current.status !== "posted")
            return { kind: "invalid_status" as const, status: current.status };
          const effect = (
            await db.execute<{ id: string; status: string }>(
              sql`
              select id, status from posting_effects
               where document_id = ${doc.id} and org_id = ${user.orgId}
            `,
              "objects",
            )
          )[0];
          if (!effect) return { kind: "no_effect" as const };
          if (effect.status !== "terminal_failed") {
            return { kind: "not_terminal" as const, status: effect.status };
          }
          return { kind: "replayable" as const, effectId: effect.id };
        });
        if (gate.kind === "scope_revoked" || gate.kind === "not_found") {
          return notFound("record");
        }
        if (gate.kind === "invalid_status") {
          return NextResponse.json(
            {
              error: `document is ${gate.status}; only a posted document's effects can be retried`,
            },
            { status: 422 },
          );
        }
        if (gate.kind === "no_effect") {
          return NextResponse.json(
            { error: "no posting effect is recorded for this document" },
            { status: 404 },
          );
        }
        if (gate.kind === "not_terminal") {
          return NextResponse.json(
            {
              error: `posting effects for this document are ${gate.status}; only a terminal-failed effect can be retried — earlier attempts still drain through the worker`,
            },
            { status: 422 },
          );
        }
        const { replayTerminalPostingEffect, PostingEffectsReplayError } =
          await import("@openbooks/engine/ledger/posting-effects");
        try {
          await replayTerminalPostingEffect({
            orgId: user.orgId,
            id: gate.effectId,
            actorId: user.id,
            reason,
          });
        } catch (e) {
          if (e instanceof PostingEffectsReplayError) {
            const missing = /was not found/.test(e.message);
            if (missing) return notFound("record");
            // An unmapped replay error rethrows into the route backstop
            // (named 4xx), never an empty body that pins as a bare
            // fallback beside the record.
            const refusal = postingRefusal(e);
            if (refusal) return refusal;
          }
          throw e;
        }
        return NextResponse.json({ ok: true });
      }
      // Posting a draft submits it first, so the same evidence rule applies —
      // assembled BEFORE the transaction opens (rendering three reports inside a
      // financial transaction would hold a connection far too long).
      if (doc.status === "draft") {
        await attachPayRunEvidence(
          doc.kind,
          doc.id,
          user.orgId,
          user.id,
          authz.allowedSubsidiaryIds,
        );
      }
      // Submit/release/post is one financial command. A posting rejection must
      // not strand a draft in approved status or persist partial financial work.
      const outcome = await withOrgTransaction(user.orgId, async () => {
        const locked = await db.execute<{
          kind: string;
          status: string;
          subsidiaryId: string | null;
        }>(
          sql`
            select kind, status, subsidiary_id as "subsidiaryId" from documents
             where id = ${doc.id} and org_id = ${user.orgId}
             for update
          `,
          "objects",
        );
        // Locked scope recheck: a rehome that landed after the precheck
        // must not let this transaction post another subsidiary's record.
        if (guardSubsidiaryScope(authz, locked[0]?.subsidiaryId)) {
          return { kind: "scope_revoked" as const };
        }
        const current = locked[0];
        if (!current) return { kind: "not_found" as const };
        const previousStatus = current.status;
        if (previousStatus === "draft") {
          const submission = await submitAndReleaseIfUngated(current.kind, doc.id, user.id);
          // Same rollback as the submit branch: a refused routing must not
          // commit its script effects alongside the 422.
          if (submission.flowError) {
            throw new ApprovalRoutingError(submission.flowError);
          }
          if (submission.gated) {
            await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
                values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: "draft", to: "pending_approval", run_id: submission.runId })}::jsonb, ${user.id})`);
            return { kind: "pending" as const, requestId: submission.runId };
          }
          // Same lifecycle evidence as the submit branch: the auto-release the
          // direct post performs must show in the audit trail (postDocument
          // evidences the post itself through its audit option below).
          await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${user.orgId}, 'documents', ${doc.id}, 'submit', ${JSON.stringify({ from: "draft", to: "approved", auto_approved: true })}::jsonb, ${user.id}),
                     (${user.orgId}, 'documents', ${doc.id}, 'approve', ${JSON.stringify({ from: "draft", to: "approved", auto: true, reason: "released without approval: no applicable Flow approval gates" })}::jsonb, ${user.id})`);
        } else if (previousStatus !== "approved") {
          return { kind: "invalid_status" as const, status: previousStatus };
        }
        // Issue gate after the status resolution so a mis-stated document meets
        // its own refusal first: posting a draft auto-submits it, and an
        // approved invoice may have lost its packet since. Dynamically imported:
        // the packet assembler pulls PDF rendering this route must not load.
        if (current.kind === "customer_invoice") {
          const { requireInvoiceBackup } = await import("../../../../lib/invoice-backup");
          await requireInvoiceBackup(user.orgId, doc.id);
        }
        const entryId = await postDocument(doc.id, await controlDeps(user.orgId), {
          deferEffects: true,
          audit: { actorId: user.id, source: "ui" },
        });
        // A deposit line on a receivable/payable account that names no
        // customer or vendor posted under the organization's "warn" policy:
        // report it on the response, read through this transaction's handle
        // so it describes exactly the posting that committed.
        const partyless =
          current.kind === "deposit" ? await partylessControlLines(user.orgId, entryId) : [];
        const warnings =
          partyless.length > 0
            ? [{ code: "partyless_control_lines" as const, accounts: partyless }]
            : [];
        return { kind: "posted" as const, entryId, previousStatus, warnings };
      });
      if (outcome.kind === "not_found") {
        return notFound("record");
      }
      if (outcome.kind === "scope_revoked") {
        return notFound("record");
      }
      if (outcome.kind === "pending") {
        return NextResponse.json(
          { ok: true, pendingApproval: true, requestId: outcome.requestId },
          { status: 202 },
        );
      }
      if (outcome.kind === "invalid_status") {
        return NextResponse.json(
          { error: `document is ${outcome.status}; only an approved document can be posted` },
          { status: 422 },
        );
      }
      await runPostDocumentEffects(doc.id, outcome.previousStatus);
      return NextResponse.json({ ok: true, entryId: outcome.entryId, warnings: outcome.warnings });
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
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      const failure = toActionFailure(e);
      if (failure.status === 500) {
        console.error("documents/actions failed", {
          action,
          documentId: body.documentId,
          error: e,
        });
      }
      return NextResponse.json(failure.body, { status: failure.status });
    }
  },
});
