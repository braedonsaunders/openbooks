import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  listReceiptCaptures,
  ReceiptCaptureRefusal,
  requireEditableReceiptReport,
} from "@openbooks/engine/payables/receipt-capture-service";
import { getDocumentCaptureRuntimeConfig } from "@openbooks/engine/payables/ap-capture-config";
import { db } from "@openbooks/engine/platform/db";
import { expenseAccessForScope, expenseGrantScope } from "@openbooks/engine/records/expense-access";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import {
  scanExpenseReceiptFiles,
  actOnExpenseReceiptCapture,
  EXPENSE_RECEIPT_MAX_BYTES,
  EXPENSE_RECEIPT_MAX_FILES,
} from "../expense-receipt-actions";
import type { ApplicationContext } from "./context";
import { ApplicationError, forbidden, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from an expense report or receipt capture read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const BASE64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .max(Math.ceil(EXPENSE_RECEIPT_MAX_BYTES / 3) * 4)
  .describe("Base64-encoded receipt file, no larger than 20 MiB when decoded.");

async function expenseAccess(context: ApplicationContext, authority: "read" | "edit") {
  const scope = expenseGrantScope((permission) => can(context.authz, permission), authority);
  if (scope === null) throw forbidden(authority === "read" ? "expenses.read" : "expenses.create");
  return expenseAccessForScope(db, context.authz.user.orgId, context.authz.user.id, scope);
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const status = response.status;
    const code =
      status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(
      code,
      typeof payload.error === "string" ? payload.error : "Receipt capture action was refused",
      status,
      payload,
    );
  }
  return payload;
}

function expenseHref(documentId: string): string {
  return `/expenses/reports?expense=${encodeURIComponent(documentId)}`;
}

export const PURCHASING_EXPENSE_RECEIPT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_expense_receipt_captures",
    title: "List Expense Receipt Captures",
    description:
      "Read receipt scans attached to a draft expense report, including extraction state and duplicate warnings. Find the report id with list_expense_reports or get_expense_report.",
    inputSchema: z.object({ documentId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "read") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses")))
        throw notFound("expense report");
      const access = await expenseAccess(context, "read");
      return {
        captures: await listReceiptCaptures(
          context.authz.user.orgId,
          input.documentId,
          new Date(),
          access,
        ),
        href: expenseHref(input.documentId),
      };
    },
  }),
  definition({
    name: "scan_expense_receipts",
    title: "Scan Expense Receipts",
    description:
      "Attach and scan receipts on an editable draft expense report using the configured document capture provider. Find the report id with list_expense_reports or get_expense_report; verify scan status with list_expense_receipt_captures.",
    inputSchema: z.object({
      documentId: UUID,
      files: z
        .array(
          z.object({
            filename: z.string().min(1).max(512).describe("Original receipt filename."),
            contentType: z
              .enum(["application/pdf", "image/jpeg", "image/png", "image/tiff"])
              .describe("Supported receipt MIME type."),
            base64: BASE64,
          }),
        )
        .min(1)
        .max(EXPENSE_RECEIPT_MAX_FILES)
        .describe("Receipt files to attach and scan; each may be up to 20 MiB."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses")))
        throw notFound("expense report");
      const access = await expenseAccess(context, "edit");
      try {
        await requireEditableReceiptReport(db, {
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          access,
        });
      } catch (error) {
        if (error instanceof ReceiptCaptureRefusal) {
          const code =
            error.status === 404
              ? "not_found"
              : error.status === 409
                ? "conflict"
                : "invalid_input";
          throw new ApplicationError(code, error.message, error.status, { code: error.code });
        }
        throw error;
      }
      const files = input.files.map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        bytes: Buffer.from(file.base64, "base64"),
      }));
      if (
        files.some(
          (file) => file.bytes.length === 0 || file.bytes.length > EXPENSE_RECEIPT_MAX_BYTES,
        )
      ) {
        throw new ApplicationError(
          "invalid_input",
          "Each receipt must be between 1 byte and 20 MB",
          422,
        );
      }
      if (
        files.reduce((size, file) => size + file.bytes.length, 0) >
        EXPENSE_RECEIPT_MAX_FILES * EXPENSE_RECEIPT_MAX_BYTES
      ) {
        throw new ApplicationError(
          "invalid_input",
          "The receipt batch exceeds the maximum upload size",
          422,
        );
      }
      const response = await scanExpenseReceiptFiles({
        gate: context.authz,
        documentId: input.documentId,
        access,
        config: await getCaptureConfig(context.authz.user.orgId),
        files,
      });
      return {
        ok: true,
        ...(await responsePayload(response)),
        href: expenseHref(input.documentId),
      };
    },
  }),
  ...(["retry", "discard"] as const).map((action) =>
    definition({
      name:
        action === "retry" ? "retry_expense_receipt_capture" : "discard_expense_receipt_capture",
      title:
        action === "retry" ? "Retry Expense Receipt Capture" : "Discard Expense Receipt Capture",
      description: `${action === "retry" ? "Retry extraction for" : "Discard"} a receipt capture while its draft expense report remains editable. Find the report and capture ids and the current scan state with list_expense_receipt_captures.`,
      inputSchema: z.object({ documentId: UUID, captureId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
      readOnly: false,
      destructive: action === "discard",
      openWorld: action === "retry",
      assistantConfirmation: "always",
      visibleTo: (authz) =>
        expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
      featureKey: "expenses",
      execute: async (context, input) => {
        if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses")))
          throw notFound("expense report");
        const access = await expenseAccess(context, "edit");
        const response = await actOnExpenseReceiptCapture({
          gate: context.authz,
          documentId: input.documentId,
          captureId: input.captureId,
          access,
          action,
        });
        return {
          ok: true,
          ...(await responsePayload(response)),
          status: action === "discard" ? "discarded" : undefined,
          href: expenseHref(input.documentId),
        };
      },
    }),
  ),
];

async function getCaptureConfig(orgId: string) {
  const config = await getDocumentCaptureRuntimeConfig(orgId);
  if (!config)
    throw new ApplicationError(
      "conflict",
      "Receipt scanning uses the document capture provider, which is disabled or not configured — an administrator enables it under Platform → AI",
      409,
      {
        code: "capture_not_configured",
        remedy: "Configure the document capture provider under Platform → AI.",
        configureHref: "/admin/ai",
      },
    );
  return config;
}
