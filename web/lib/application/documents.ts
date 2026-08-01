import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  DocumentVoidError,
  requestDocumentVoid,
} from "@openbooks/engine/src/document-void.ts";
import { submitAndReleaseIfUngated } from "@openbooks/engine/src/flows/index.ts";
import { postDocument, PostingError } from "@openbooks/engine/src/posting.ts";
import {
  controlDeps,
  createPermission,
  createPostedCorrectionDraft,
  DOC_KINDS,
  DocumentEditError,
  loadDocument,
  postPermission,
  type DocumentEditInput,
} from "../documents";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
} from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

interface DocumentHeader {
  id: string;
  kind: string;
  status: string;
  subsidiaryId: string | null;
}

async function documentHeader(
  context: ApplicationContext,
  id: string,
): Promise<DocumentHeader> {
  if (!isUuid(id)) throw invalidInput("documentId must be a UUID");
  const result = (await db.execute(sql`
    select id, kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and org_id = ${context.authz.user.orgId}
     limit 1
  `)) as unknown as { rows: DocumentHeader[] };
  const header = result.rows[0];
  if (!header) throw notFound("document");
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

function domainFailure(error: unknown): never {
  if (
    error instanceof DocumentVoidError
    || error instanceof DocumentEditError
    || error instanceof PostingError
  ) {
    throw new ApplicationError(
      "invalid_input",
      error.message,
      error instanceof DocumentEditError ? error.status : 422,
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
  if (header.status !== "posted") {
    throw invalidInput("only a posted transaction can be corrected");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "documents.correct",
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId, correction: input.correction },
    execute: async () => {
      try {
        const replacement = await createPostedCorrectionDraft(
          input.documentId,
          input.correction,
          {
            orgId: context.authz.user.orgId,
            userId: context.authz.user.id,
            source: context.source,
          },
        );
        const voidResult = await requestDocumentVoid({
          documentId: input.documentId,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          reason: input.correction.amendmentReason ?? "",
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
