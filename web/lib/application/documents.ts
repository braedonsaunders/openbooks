import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  DocumentVoidError,
  requestDocumentVoid,
} from "@openbooks/engine/src/ledger/document-void.ts";
import { submitAndReleaseIfUngated } from "@openbooks/engine/src/flows/index.ts";
import { ControlAccountsIncompleteError } from "@openbooks/engine/src/records/control-accounts.ts";
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";
import { PostingError } from "@openbooks/engine/src/ledger/posting-contracts.ts";
import { controlDeps, loadDocument } from "@openbooks/engine/src/ledger/document-service.ts";
import { DocumentEditError } from "@openbooks/engine/src/records/document-edit-policy.ts";
import type { DocumentEditInput } from "@openbooks/engine/src/ledger/document-input.ts";
import { createPermission, postPermission, DOC_KINDS } from "../document-kinds";
// The remaining editor dependency is deliberate: correction writes still compose
// custom fields, tax, allocations, audit and flows in the shared web edit service.
import { createPostedCorrectionDraft, runPostedCorrectionDraftFlows, isDocKindEnabled } from "../documents.ts";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
} from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";
type DocumentHeader = {
  id: string;
  kind: string;
  status: string;
  subsidiaryId: string | null;
};

async function documentHeader(
  context: ApplicationContext,
  id: string,
): Promise<DocumentHeader> {
  if (!isUuid(id)) throw invalidInput("documentId must be a UUID");
  const result = (await db.execute<DocumentHeader>(sql`
    select id, kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and org_id = ${context.authz.user.orgId}
     limit 1
  `));
  const header = result.rows[0];
  if (!header) throw notFound("document");
  if (!(await isDocKindEnabled(context.authz.user.orgId, header.kind))) {
    throw notFound("document");
  }
  assertSubsidiaryAccess(context, header.subsidiaryId);
  return header;
}

function lifecyclePermission(kind: string, action: "submit" | "post"): string {
  try {
    return action === "post" ? postPermission(kind) : createPermission(kind);
  } catch {
    throw new ApplicationError(
      "unsupported_operation",
      "this transaction type uses a dedicated lifecycle",
      422,
    );
  }
}

function voidPermission(kind: string): string {
  if (kind === "vendor_payment") return "ap.pay";
  if (kind === "customer_payment") return "ar.pay";
  if (kind === "journal") return "gl.post";
  if (kind === "expense_report") return "ap.post";
  if (kind === "purchase_order") return "ap.create";
  if (kind === "sales_order" || kind === "quote") return "ar.create";
  try {
    return postPermission(kind);
  } catch {
    try {
      return createPermission(kind);
    } catch {
      throw new ApplicationError(
        "unsupported_operation",
        "this transaction type uses a dedicated void workflow",
        422,
      );
    }
  }
}

export function domainFailure(error: unknown): never {
  // The backup gate's error class lives in invoice-backup next to the packet
  // assembler (which pulls PDF rendering no lifecycle caller may load
  // statically), so it is matched by its stable code, not by instanceof.
  if (
    (error instanceof Error && (error as { code?: unknown }).code === 'invoice_backup_required')
    || error instanceof DocumentVoidError
    || error instanceof DocumentEditError
    || error instanceof PostingError
    || error instanceof ControlAccountsIncompleteError
  ) {
    throw new ApplicationError(
      (error instanceof DocumentEditError || error instanceof DocumentVoidError) && error.status === 409 ? "conflict" : "invalid_input",
      error.message,
      error instanceof DocumentEditError || error instanceof DocumentVoidError ? error.status : 422,
    );
  }
  throw error;
}

export async function advanceDocumentLifecycle(
  context: ApplicationContext,
  input: {
    documentId: string;
    action: "submit" | "post";
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  const header = await documentHeader(context, input.documentId);
  assertApplicationPermission(context, lifecyclePermission(header.kind, input.action));
  const outcome = await executeIdempotent({
    context,
    operation: `documents.${input.action}`,
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId, action: input.action },
    execute: async () => {
      try {
        let currentStatus = header.status;
        if (currentStatus === "draft") {
          const submission = await submitAndReleaseIfUngated(
            header.kind,
            input.documentId,
            context.authz.user.id,
          );
          if (submission.flowError) {
            throw new ApplicationError(
              "invalid_input",
              `approval could not be routed: ${submission.flowError}`,
              422,
            );
          }
          if (submission.gated) {
            return {
              status: "pending_approval",
              requestId: submission.runId,
              document: await loadDocument(input.documentId, context.authz.user.orgId),
            };
          }
          currentStatus = "approved";
        }
        // A backup-required project invoice is issued only with its
        // substantiation packet. The check sits after the draft resolution so
        // a gated or mis-stated document meets its own refusal first, and it
        // covers submit, post-from-draft, and post-from-approved alike.
        // Dynamically imported: the packet assembler pulls PDF rendering that
        // every other lifecycle caller must not pay for.
        if (header.kind === "customer_invoice") {
          const { requireInvoiceBackup } = await import("../invoice-backup");
          await requireInvoiceBackup(context.authz.user.orgId, input.documentId);
        }
        if (input.action === "submit") {
          if (currentStatus !== "approved") {
            throw new ApplicationError(
              "invalid_input",
              `document is ${currentStatus}; only a draft can be submitted`,
              422,
            );
          }
          return {
            status: "approved",
            document: await loadDocument(input.documentId, context.authz.user.orgId),
          };
        }
        if (currentStatus !== "approved") {
          throw new ApplicationError(
            "invalid_input",
            `document is ${currentStatus}; only an approved document can be posted`,
            422,
          );
        }
        const entryId = await postDocument(
          input.documentId,
          await controlDeps(context.authz.user.orgId),
          { audit: { actorId: context.authz.user.id, source: context.source } },
        );
        return {
          status: "posted",
          entryId,
          document: await loadDocument(input.documentId, context.authz.user.orgId),
        };
      } catch (error) {
        domainFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

/**
 * Post a manual journal: the application-layer twin of POST
 * /api/journals/actions. Journal documents are not in DOC_KINDS, so the
 * generic submit/post lifecycle refuses them ("dedicated lifecycle"); this
 * command runs the same services the route calls — submitAndReleaseIfUngated
 * for drafts, then engine postDocument — under gl.post with the same
 * journal-kind ownership and subsidiary checks. Like the other application
 * lifecycle commands the post effects commit atomically inside the
 * idempotent command instead of deferring past commit.
 */
export async function postJournalDocument(
  context: ApplicationContext,
  input: {
    documentId: string;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  const header = await documentHeader(context, input.documentId);
  // The route 404s anything that is not a journal of this org.
  if (header.kind !== "journal") throw notFound("journal");
  assertApplicationPermission(context, "gl.post");
  const outcome = await executeIdempotent({
    context,
    operation: "documents.journal.post",
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId },
    execute: async () => {
      try {
        let currentStatus = header.status;
        if (currentStatus === "draft") {
          const submission = await submitAndReleaseIfUngated(
            "journal",
            input.documentId,
            context.authz.user.id,
          );
          if (submission.flowError) {
            throw new ApplicationError(
              "invalid_input",
              `approval could not be routed: ${submission.flowError}`,
              422,
            );
          }
          if (submission.gated) {
            return {
              status: "pending_approval",
              requestId: submission.runId,
            };
          }
          currentStatus = "approved";
        }
        if (currentStatus !== "approved") {
          throw new ApplicationError(
            "invalid_input",
            `journal is ${currentStatus}; only an approved journal can be posted`,
            422,
          );
        }
        const entryId = await postDocument(
          input.documentId,
          await controlDeps(context.authz.user.orgId),
          { audit: { actorId: context.authz.user.id, source: context.source } },
        );
        return { status: "posted", entryId };
      } catch (error) {
        domainFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function voidDocument(
  context: ApplicationContext,
  input: {
    documentId: string;
    reason: string;
    reversalDate?: string | null;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  const header = await documentHeader(context, input.documentId);
  assertApplicationPermission(context, voidPermission(header.kind));
  const outcome = await executeIdempotent({
    context,
    operation: "documents.void",
    idempotencyKey: input.idempotencyKey,
    request: {
      documentId: input.documentId,
      reason: input.reason,
      reversalDate: input.reversalDate ?? null,
    },
    execute: async () => {
      try {
        return await requestDocumentVoid({
          documentId: input.documentId,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          reason: input.reason,
          reversalDate: input.reversalDate,
          source: context.source,
        });
      } catch (error) {
        domainFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function correctPostedDocument(
  context: ApplicationContext,
  input: {
    documentId: string;
    correction: DocumentEditInput;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  const header = await documentHeader(context, input.documentId);
  if (!DOC_KINDS[header.kind]) {
    throw new ApplicationError(
      "unsupported_operation",
      "this transaction type uses a dedicated correction workflow",
      422,
    );
  }
  assertApplicationPermission(context, createPermission(header.kind));
  assertApplicationPermission(context, postPermission(header.kind));
  // The replacement may be re-homed by the correction body. A restricted
  // actor may only re-home it into an entity it can see: an omitted id keeps
  // the source's (already gated) entity, an explicit id is gated here like
  // every records/payments write, and an explicit null is an unresolved
  // entity that fails closed for a restricted scope.
  const rehomedSubsidiaryId = input.correction.subsidiaryId;
  assertSubsidiaryAccess(context, rehomedSubsidiaryId === undefined ? header.subsidiaryId : rehomedSubsidiaryId);
  const outcome = await executeIdempotent({
    context,
    operation: "documents.correct",
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId, correction: input.correction },
    execute: async () => {
      try {
        // A completed idempotency key must replay even after the first attempt
        // voided the source. Fresh executions still enforce the posted guard;
        // executeIdempotent never invokes this callback for a replay.
        if (header.status !== "posted") {
          throw invalidInput("only a posted transaction can be corrected");
        }
        const replacement = await createPostedCorrectionDraft(
          input.documentId,
          input.correction,
          {
            orgId: context.authz.user.orgId,
            userId: context.authz.user.id,
            source: context.source,
          },
          { deferFlows: true },
        );
        const voidResult = await requestDocumentVoid({
          documentId: input.documentId,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          reason: input.correction.amendmentReason ?? "",
          source: context.source,
        });
        // Approval routing is part of the idempotent command. Flow runs, gates,
        // and deferred effects must commit with the correction and void so a
        // failed dispatch rolls the command back and a replay cannot skip it.
        await runPostedCorrectionDraftFlows(replacement.id, header.kind, {
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          source: context.source,
        });
        return {
          correctionId: replacement.id,
          correctionNumber: replacement.documentNumber,
          voidStatus: voidResult.status,
          requestId: voidResult.runId,
        };
      } catch (error) {
        // executeIdempotent owns the transaction; an error rolls both the
        // replacement and void request back. This fallback is defensive if the
        // function is ever called from a non-transactional adapter.
        if (error instanceof DocumentEditError || error instanceof DocumentVoidError) {
          domainFailure(error);
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}
