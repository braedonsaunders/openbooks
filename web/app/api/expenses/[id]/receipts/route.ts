import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { MULTIPART_FRAMING_BYTES, parseFormDataBody } from "@/lib/api/form-data";
import { can } from "@/lib/authz";
import { db } from "@openbooks/engine/platform/db";
import {
  documentCaptureOperational,
  getDocumentCaptureRuntimeConfig,
  type DocumentCaptureRuntimeConfig,
} from "@openbooks/engine/payables/ap-capture-config";
import {
  listReceiptCaptures,
  loadReceiptReport,
  ReceiptCaptureRefusal,
  requireEditableReceiptReport,
} from "@openbooks/engine/payables/receipt-capture-service";
import { isUuid } from "../../../../../lib/list-params";
import {
  authorizeExpenses,
  expenseAccess,
  expenseAccessAllows,
} from "../../../../../lib/expense-access";
import { scanExpenseReceiptFiles } from "../../../../../lib/expense-receipt-actions";

export const runtime = "nodejs";

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;
const CONFIGURE_HREF = "/admin/ai";

const params = z.object({ id: z.string().refine(isUuid) });

/**
 * Receipts scanned onto one expense report, with whether document capture
 * can run and where an administrator configures it. Self-service callers
 * read only their own report's receipts.
 */
export const GET = defineRoute({
  params,
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("read"),
  feature: "expenses",
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id } = routeParams as { id: string };
    const access = await expenseAccess(gate, "read");
    if (!access)
      return apiErrorResponse(
        new ReceiptCaptureRefusal(404, "not_found", "Expense report not found"),
      );
    try {
      const report = await loadReceiptReport(db, {
        orgId: gate.user.orgId,
        documentId: id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        access,
      });
      const [captures, operational, edit] = await Promise.all([
        listReceiptCaptures(gate.user.orgId, id, new Date(), access),
        documentCaptureOperational(gate.user.orgId),
        expenseAccess(gate, "edit"),
      ]);
      return NextResponse.json({
        captures,
        reportCurrency: report.currency,
        canScan:
          report.status === "draft" && edit !== null && expenseAccessAllows(edit, report.partyId),
        captureOperational: operational,
        canConfigure: can(gate, "admin.ai.manage"),
        configureHref: CONFIGURE_HREF,
      });
    } catch (error) {
      if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error);
      throw error;
    }
  },
});

/**
 * Scan receipts onto a draft expense report. Each file is attached to the
 * report as evidence and registered in one transaction, then read through
 * the organization's document capture provider. A file the provider cannot
 * read is kept as a failed capture with its reason and can be retried.
 * Self-service callers scan only onto their own draft.
 */
export const POST = defineRoute({
  params,
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  handler: async ({ request, authz: gate, params: routeParams }) => {
    const { id } = routeParams as { id: string };
    const orgId = gate.user.orgId;
    const access = await expenseAccess(gate, "edit");
    if (!access)
      return apiErrorResponse(
        new ReceiptCaptureRefusal(404, "not_found", "Expense report not found"),
      );
    try {
      await requireEditableReceiptReport(db, {
        orgId,
        documentId: id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        access,
      });
    } catch (error) {
      if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error);
      throw error;
    }
    let resolvedConfig: DocumentCaptureRuntimeConfig | null;
    try {
      resolvedConfig = await getDocumentCaptureRuntimeConfig(orgId);
    } catch (error) {
      // A misconfigured endpoint is a typed 422 naming its remedy; anything
      // else is unexpected and answers through the shared mapping.
      return apiErrorResponse(error);
    }
    const config = resolvedConfig;
    if (!config) {
      return NextResponse.json(
        {
          error:
            "Receipt scanning uses the document capture provider, which is disabled or not configured — an administrator enables it under Platform → AI",
          code: "capture_not_configured",
          configureHref: CONFIGURE_HREF,
        },
        { status: 409 },
      );
    }

    const parsed = await parseFormDataBody(request, {
      maxBodyBytes: MAX_FILES * MAX_BYTES + MULTIPART_FRAMING_BYTES,
      invalid: { error: "Send the receipts as multipart form data" },
      tooLarge: {
        error: `Scan at most ${MAX_FILES} receipts of up to 20 MB each`,
        code: "invalid_size",
      },
    });
    if (!parsed.ok) return parsed.response;
    const files = parsed.data
      .getAll("files")
      .filter((value): value is File => value instanceof File);
    return scanExpenseReceiptFiles({
      gate,
      documentId: id,
      access,
      config,
      files: await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          contentType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
        })),
      ),
    });
  },
});
