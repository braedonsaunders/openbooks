import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { assertDocumentEditRevision } from "@openbooks/engine/records/document-edit-policy";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { runPostDocumentEffects } from "@openbooks/engine/ledger/posting-dispatch";
import { submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import {
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from "@openbooks/engine/records/control-accounts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { uuidId } from "@/lib/api/json";
import { budgetaryControlAdvisories, partylessControlLines } from "@/lib/journal-warnings";
import { ApprovalRoutingError } from "@/lib/approval-routing-error";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const journalActionBody = z.object({
  action: z.literal("post", { error: "unknown action" }),
  documentId: z
    .string({ error: "documentId required" })
    .refine((v) => uuidId.safeParse(v).success, "documentId required"),
  // The exact revision the reviewer saw. When present it is checked under the
  // row lock, so a post after a concurrent edit is refused rather than posting
  // content nobody reviewed. Optional for other API callers.
  expectedUpdatedAt: z.string().min(1).optional(),
});

/**
 * Manual-journal actions. A draft is submitted through the tenant's active
 * Flow configuration: no gate releases it immediately, while any authored
 * single- or multi-leg gate topology leaves it pending until Flow resolves.
 */

export const POST = defineRoute({
  permission: "gl.post",
  feature: {
    none: "Manual journal posting is a core general-ledger workflow with no organization feature switch.",
  },
  body: journalActionBody,
  handler: async ({ body, authz: gate }) => {
    const { documentId, expectedUpdatedAt } = body;

    try {
      switch (body.action) {
        case "post": {
          const outcome = await withOrgTransaction(gate.user.orgId, async () => {
            // Serialize the lifecycle and posting decision at the aggregate root.
            // If posting fails, the draft→approved release rolls back with it.
            const owned = await db.execute<{
              id: string;
              status: string;
              subsidiaryId: string | null;
              revision: string;
            }>(
              sql`
              select id, status, subsidiary_id as "subsidiaryId",
                     ${documentRevisionCounterSql(sql.raw("revision_seq"))} as revision
                from documents
               where id = ${documentId} and kind = 'journal' and org_id = ${gate.user.orgId}
               for update
            `,
              "objects",
            );
            if (!owned[0]) return { kind: "not_found" as const };
            const scopeDenied = guardSubsidiaryScope(gate, owned[0].subsidiaryId);
            if (scopeDenied) return { kind: "scope_denied" as const, response: scopeDenied };
            // Fence on the locked row's exact revision: a mismatch throws before
            // any flow release or posting write, so the transaction rolls back.
            if (expectedUpdatedAt !== undefined) {
              assertDocumentEditRevision(expectedUpdatedAt, owned[0].revision);
            }
            const previousStatus = owned[0].status;
            if (previousStatus === "draft") {
              const submission = await submitAndReleaseIfUngated(
                "journal",
                documentId,
                gate.user.id,
              );
              // A refused routing throws: answering 422 from inside this
              // transaction would commit the submission's script effects
              // alongside the refusal. The catch below answers the same 422
              // after the rollback.
              if (submission.flowError) {
                throw new ApprovalRoutingError(submission.flowError);
              }
              if (submission.gated) {
                return { kind: "pending" as const, requestId: submission.runId };
              }
            } else if (previousStatus !== "approved") {
              return { kind: "invalid_status" as const, status: previousStatus };
            }

            // Defer after-post scripts/flows until the database transaction has
            // durably committed. Financial writes remain inside this transaction.
            const entryId = await postDocument(
              documentId,
              {
                control: await loadRequiredControlAccounts(gate.user.orgId),
              },
              {
                deferEffects: true,
                audit: { actorId: gate.user.id, source: "ui" },
              },
            );
            // A party-less AR/AP-control leg posts legitimately but sits
            // outside every subledger: report it on the response instead of
            // accepting the journal silently. The drawer pins the
            // warning on the record; the aging carries the balance explicitly.
            // Both collectors read through this transaction's own handle, so
            // both warnings describe the posting that just committed. The
            // budgetary read is advisory-only and never rolls the posting
            // back; hard budget_exceeded still refuses pre-commit inside the
            // balancing seam.
            // The collectors share one transaction-bound handle: run them
            // sequentially so their reads never interleave on that handle.
            const partyless = await partylessControlLines(gate.user.orgId, entryId);
            const advisories = await budgetaryControlAdvisories(gate.user.orgId, entryId);
            const warnings = [
              ...(partyless.length > 0
                ? [{ code: "partyless_control_lines" as const, accounts: partyless }]
                : []),
              ...advisories,
            ];
            return { kind: "posted" as const, entryId, previousStatus, warnings };
          });

          if (outcome.kind === "not_found") {
            return notFound("record");
          }
          if (outcome.kind === "scope_denied") {
            return outcome.response;
          }
          if (outcome.kind === "pending") {
            return NextResponse.json(
              { ok: true, pendingApproval: true, requestId: outcome.requestId },
              { status: 202 },
            );
          }
          if (outcome.kind === "invalid_status") {
            return NextResponse.json(
              { error: `journal is ${outcome.status}; only an approved journal can be posted` },
              { status: 422 },
            );
          }
          await runPostDocumentEffects(documentId, outcome.previousStatus);
          return NextResponse.json({
            ok: true,
            entryId: outcome.entryId,
            warnings: outcome.warnings,
          });
        }
        default:
          return NextResponse.json({ error: "unknown action" }, { status: 400 });
      }
    } catch (e) {
      // Posting refusals (kernel rules or unconfigured org control accounts)
      // and refused approval routings (already rolled back) are request-state
      // failures, not server defects.
      if (
        e instanceof PostingError ||
        e instanceof ControlAccountsIncompleteError ||
        e instanceof ApprovalRoutingError
      )
        return apiErrorResponse(e, { safeStatus: 422 });
      return apiErrorResponse(e);
    }
  },
});
