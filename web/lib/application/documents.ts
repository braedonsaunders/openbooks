import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { DocumentVoidError, requestDocumentVoid } from "@openbooks/engine/documents";
import { SubmitError, submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import { ControlAccountsIncompleteError } from "@openbooks/engine/records/control-accounts";
import { postDocument } from "@openbooks/engine/documents";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { controlDeps, loadDocument } from "@openbooks/engine/documents";
import { DocumentEditError } from "@openbooks/engine/documents";
import type { DocumentEditInput } from "@openbooks/engine/documents";
import { createPermission, postPermission, DOC_KINDS } from "../document-kinds";
import { customFieldViewerFor } from "../custom-fields";
import { isDocKindEnabled } from "@openbooks/engine/documents/write";
import { applyPostedDocumentCorrection } from "@openbooks/engine/ledger/document-correction-editing";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";
type DocumentHeader = {
  id: string;
  kind: string;
  status: string;
  subsidiaryId: string | null;
};

async function documentHeader(context: ApplicationContext, id: string): Promise<DocumentHeader> {
  if (!isUuid(id)) throw invalidInput("documentId must be a UUID");
  const result = await db.execute<DocumentHeader>(
    sql`
    select id, kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and org_id = ${context.authz.user.orgId}
     limit 1
  `,
    "objects",
  );
  const header = result[0];
  if (!header) throw notFound("document");
  if (!(await isDocKindEnabled(context.authz.user.orgId, header.kind))) {
    throw notFound("document");
  }
  assertSubsidiaryAccess(context, header.subsidiaryId);
  return header;
}

/** Re-read and retain the document row lock for every idempotent mutation. */
async function lockDocumentHeader(
  context: ApplicationContext,
  id: string,
): Promise<DocumentHeader> {
  if (!isUuid(id)) throw invalidInput("documentId must be a UUID");
  const result = await db.execute<DocumentHeader>(
    sql`
    select id, kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and org_id = ${context.authz.user.orgId}
     for update
  `,
    "objects",
  );
  const header = result[0];
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
  if (kind === "purchase_order") return "purchase_orders.create";
  if (kind === "quote") return "estimates.create";
  if (kind === "sales_order") return "ar.create";
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
    (error instanceof Error && (error as { code?: unknown }).code === "invoice_backup_required") ||
    error instanceof DocumentVoidError ||
    error instanceof DocumentEditError ||
    error instanceof PostingError ||
    error instanceof ControlAccountsIncompleteError ||
    error instanceof SubmitError
  ) {
    throw new ApplicationError(
      (error instanceof DocumentEditError || error instanceof DocumentVoidError) &&
        error.status === 409
        ? "conflict"
        : "invalid_input",
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
        const lockedHeader = await lockDocumentHeader(context, input.documentId);
        assertApplicationPermission(context, lifecyclePermission(lockedHeader.kind, input.action));
        let currentStatus = lockedHeader.status;
        if (currentStatus === "draft") {
          const submission = await submitAndReleaseIfUngated(
            lockedHeader.kind,
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
              document: await loadDocument(
                input.documentId,
                context.authz.user.orgId,
                customFieldViewerFor(context.authz),
              ),
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
        if (lockedHeader.kind === "customer_invoice") {
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
            document: await loadDocument(
              input.documentId,
              context.authz.user.orgId,
              customFieldViewerFor(context.authz),
            ),
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
          document: await loadDocument(
            input.documentId,
            context.authz.user.orgId,
            customFieldViewerFor(context.authz),
          ),
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
        const lockedHeader = await lockDocumentHeader(context, input.documentId);
        if (lockedHeader.kind !== "journal") throw notFound("journal");
        assertApplicationPermission(context, "gl.post");
        let currentStatus = lockedHeader.status;
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
    reversalPeriodId?: string | null;
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
      reversalPeriodId: input.reversalPeriodId ?? null,
    },
    execute: async () => {
      try {
        const lockedHeader = await lockDocumentHeader(context, input.documentId);
        assertApplicationPermission(context, voidPermission(lockedHeader.kind));
        return await requestDocumentVoid({
          documentId: input.documentId,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          reason: input.reason,
          reversalDate: input.reversalDate,
          reversalPeriodId: input.reversalPeriodId,
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
  assertSubsidiaryAccess(
    context,
    rehomedSubsidiaryId === undefined ? header.subsidiaryId : rehomedSubsidiaryId,
  );
  const outcome = await executeIdempotent({
    context,
    operation: "documents.correct",
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId, correction: input.correction },
    execute: async () => {
      try {
        // The engine locks and rechecks the source, grants and feature state.
        // Completed idempotency keys replay without invoking this callback.
        // Replacement draft flows dispatch with the correction, so a failed
        // dispatch rolls the command back and a replay cannot skip it.
        const corrected = await applyPostedDocumentCorrection(
          {
            orgId: context.authz.user.orgId,
            userId: context.authz.user.id,
            source: context.source,
          },
          { documentId: input.documentId, correction: input.correction },
          { draftFlows: "with-correction" },
        );
        const { replacement } = corrected;
        if (corrected.kind === "void-and-reissue") {
          return {
            correctionOutcome: corrected.kind,
            correctionId: replacement.id,
            correctionNumber: replacement.documentNumber,
            voidStatus: corrected.voidResult.status,
            requestId: corrected.voidResult.runId,
            reclassEntryIds: [],
          };
        }
        return {
          correctionOutcome: corrected.kind,
          correctionId: replacement.id,
          correctionNumber: replacement.documentNumber,
          voidStatus: null,
          requestId: null,
          reclassEntryIds: corrected.reclassEntryIds,
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
