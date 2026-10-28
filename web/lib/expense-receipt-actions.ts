import "server-only";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { captureContentMatchesMime } from "@openbooks/engine/payables/ap-capture";
import {
  getDocumentCaptureRuntimeConfig,
  type DocumentCaptureRuntimeConfig,
} from "@openbooks/engine/payables/ap-capture-config";
import { isReceiptContentType } from "@openbooks/engine/payables/receipt-capture";
import {
  assertLlmReadable,
  LlmCaptureError,
} from "@openbooks/engine/payables/document-capture-llm";
import {
  claimReceiptRetry,
  discardReceiptCapture,
  extractReceiptCapture,
  listReceiptCaptures,
  ReceiptCaptureRefusal,
  receiptReader,
  registerReceiptCapture,
  requireEditableReceiptReport,
} from "@openbooks/engine/payables/receipt-capture-service";
import { uploadAndAttach } from "./file-cabinet";
import {
  attachmentMutationRefusal,
  authorizeAttachmentTargetMutation,
} from "@/app/api/file-cabinet/lib";
import { apiErrorResponse } from "./api/error-response";
import { type Authz } from "./authz";
import { type ExpenseAccess } from "./expense-access";

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;
const CONFIGURE_HREF = "/admin/ai";

export type ExpenseReceiptUpload = { filename: string; contentType: string; bytes: Buffer };

function safeFilename(value: string): string {
  return (
    basename(value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 240) || "receipt"
  );
}

/** Attach receipt evidence and run the same provider extraction used by the expense drawer. */
export async function scanExpenseReceiptFiles(input: {
  gate: Authz;
  documentId: string;
  access: ExpenseAccess;
  config: DocumentCaptureRuntimeConfig;
  files: ExpenseReceiptUpload[];
}): Promise<NextResponse> {
  const orgId = input.gate.user.orgId;
  if (input.files.length === 0)
    return NextResponse.json(
      { error: "Choose at least one receipt to scan", code: "no_files" },
      { status: 400 },
    );
  if (input.files.length > MAX_FILES)
    return NextResponse.json(
      { error: `Scan at most ${MAX_FILES} receipts at a time`, code: "too_many_files" },
      { status: 422 },
    );
  const prepared: Array<{ filename: string; contentType: string; bytes: Buffer; hash: string }> =
    [];
  for (const file of input.files) {
    const filename = safeFilename(file.filename);
    const contentType = file.contentType.split(";")[0]!.trim().toLowerCase();
    if (!isReceiptContentType(contentType))
      return NextResponse.json(
        {
          error: `${filename} is not a PDF, JPEG, PNG or TIFF receipt`,
          code: "unsupported_type",
          filename,
        },
        { status: 422 },
      );
    if (file.bytes.length <= 0 || file.bytes.length > MAX_BYTES)
      return NextResponse.json(
        { error: `${filename} must be between 1 byte and 20 MB`, code: "invalid_size", filename },
        { status: 422 },
      );
    if (input.config.provider === "llm_vision") {
      try {
        assertLlmReadable(input.config.llm.provider, contentType);
      } catch (error) {
        if (error instanceof LlmCaptureError)
          return NextResponse.json(
            { error: `${filename}: ${error.message}`, code: error.code, filename },
            { status: 422 },
          );
        throw error;
      }
    }
    if (!captureContentMatchesMime(file.bytes, contentType))
      return NextResponse.json(
        {
          error: `${filename} does not contain the ${contentType} content its type names`,
          code: "content_type_mismatch",
          filename,
        },
        { status: 422 },
      );
    prepared.push({
      filename,
      contentType,
      bytes: file.bytes,
      hash: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }

  const created: string[] = [];
  const results: Array<{
    filename: string;
    id?: string;
    status: "scanned" | "failed";
    error?: string;
  }> = [];
  for (const upload of prepared) {
    let registered: { id: string; attempt: number };
    try {
      registered = await db.transaction(async (tx) => {
        await requireEditableReceiptReport(tx, {
          orgId,
          documentId: input.documentId,
          allowedSubsidiaryIds: input.gate.allowedSubsidiaryIds,
          access: input.access,
          forUpdate: true,
        });
        const attached = await uploadAndAttach({
          orgId,
          targetTable: "documents",
          targetId: input.documentId,
          filename: upload.filename,
          contentType: upload.contentType,
          bytes: upload.bytes,
          createdBy: input.gate.user.id,
          executor: tx,
          authorizeTarget: (executor) =>
            authorizeAttachmentTargetMutation(input.gate, "documents", input.documentId, executor),
        });
        return registerReceiptCapture(tx, {
          orgId,
          documentId: input.documentId,
          fileId: attached.id,
          contentHash: upload.hash,
          originalFilename: upload.filename,
          actorId: input.gate.user.id,
          reader: receiptReader(input.config),
        });
      });
    } catch (error) {
      const refusal = attachmentMutationRefusal(error);
      if (refusal) return refusal;
      if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error);
      throw error;
    }
    created.push(registered.id);
    await extractReceiptCapture({
      orgId,
      captureId: registered.id,
      attempt: registered.attempt,
      actorId: input.gate.user.id,
    });
    results.push({ filename: upload.filename, id: registered.id, status: "scanned" });
  }
  const captures = (
    await listReceiptCaptures(orgId, input.documentId, new Date(), input.access)
  ).filter((capture) => created.includes(capture.id));
  for (const result of results) {
    const capture = captures.find((entry) => entry.id === result.id);
    if (capture?.status === "failed") {
      result.status = "failed";
      result.error = capture.lastError ?? undefined;
    }
  }
  return NextResponse.json(
    { captures, results },
    { status: results.some((result) => result.status === "failed") ? 207 : 201 },
  );
}

/** Retry or discard a receipt capture while its expense report remains editable. */
export async function actOnExpenseReceiptCapture(input: {
  gate: Authz;
  documentId: string;
  captureId: string;
  access: ExpenseAccess;
  action: "retry" | "discard";
}): Promise<NextResponse> {
  const orgId = input.gate.user.orgId;
  const scope = {
    orgId,
    documentId: input.documentId,
    allowedSubsidiaryIds: input.gate.allowedSubsidiaryIds,
    access: input.access,
  };
  try {
    if (input.action === "discard") {
      await db.transaction(async (tx) => {
        await requireEditableReceiptReport(tx, { ...scope, forUpdate: true });
        await discardReceiptCapture(tx, {
          orgId,
          documentId: input.documentId,
          captureId: input.captureId,
          actorId: input.gate.user.id,
        });
      });
      return NextResponse.json({ ok: true });
    }
    if (!(await getDocumentCaptureRuntimeConfig(orgId)))
      return NextResponse.json(
        {
          error:
            "Receipt scanning uses the document capture provider, which is disabled or not configured — an administrator enables it under Platform → AI",
          code: "capture_not_configured",
          configureHref: CONFIGURE_HREF,
        },
        { status: 409 },
      );
    const attempt = await db.transaction(async (tx) => {
      await requireEditableReceiptReport(tx, { ...scope, forUpdate: true });
      return claimReceiptRetry(tx, {
        orgId,
        documentId: input.documentId,
        captureId: input.captureId,
        actorId: input.gate.user.id,
      });
    });
    await extractReceiptCapture({
      orgId,
      captureId: input.captureId,
      attempt,
      actorId: input.gate.user.id,
    });
    const capture =
      (await listReceiptCaptures(orgId, input.documentId, new Date(), input.access)).find(
        (entry) => entry.id === input.captureId,
      ) ?? null;
    return NextResponse.json({ capture });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export const EXPENSE_RECEIPT_MAX_FILES = MAX_FILES;
export const EXPENSE_RECEIPT_MAX_BYTES = MAX_BYTES;
