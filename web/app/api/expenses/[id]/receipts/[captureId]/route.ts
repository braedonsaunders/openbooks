import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { db } from "@openbooks/engine/platform/db";
import { getDocumentCaptureRuntimeConfig } from "@openbooks/engine/payables/ap-capture-config";
import {
  claimReceiptRetry,
  discardReceiptCapture,
  extractReceiptCapture,
  listReceiptCaptures,
  ReceiptCaptureRefusal,
  requireEditableReceiptReport,
} from "@openbooks/engine/payables/receipt-capture-service";
import { isUuid } from "../../../../../../lib/list-params";
import { authorizeExpenses, expenseAccess } from "../../../../../../lib/expense-access";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  action: z.enum(["retry", "discard"]),
});

/**
 * Retry a failed or interrupted receipt scan, or discard a receipt so it no
 * longer drafts a line or warns as a duplicate. Both require the report to
 * be a draft the caller may edit; self-service callers act only on their own.
 */
export const POST = defineRoute({
  params: z.object({ id: z.string().refine(isUuid), captureId: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: bodySchema,
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id, captureId } = routeParams as { id: string; captureId: string };
    const orgId = gate.user.orgId;
    const access = await expenseAccess(gate, "edit");
    if (!access)
      return apiErrorResponse(
        new ReceiptCaptureRefusal(404, "not_found", "Expense report not found"),
      );
    const scope = {
      orgId,
      documentId: id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      access,
    };
    try {
      if (body.action === "discard") {
        await db.transaction(async (tx) => {
          await requireEditableReceiptReport(tx, { ...scope, forUpdate: true });
          await discardReceiptCapture(tx, {
            orgId,
            documentId: id,
            captureId,
            actorId: gate.user.id,
          });
        });
        return NextResponse.json({ ok: true });
      }
      if (!(await getDocumentCaptureRuntimeConfig(orgId))) {
        return NextResponse.json(
          {
            error:
              "Receipt scanning uses the document capture provider, which is disabled or not configured — an administrator enables it under Platform → AI",
            code: "capture_not_configured",
            configureHref: "/admin/ai",
          },
          { status: 409 },
        );
      }
      const attempt = await db.transaction(async (tx) => {
        await requireEditableReceiptReport(tx, { ...scope, forUpdate: true });
        return claimReceiptRetry(tx, { orgId, documentId: id, captureId, actorId: gate.user.id });
      });
      await extractReceiptCapture({ orgId, captureId, attempt, actorId: gate.user.id });
      const capture =
        (await listReceiptCaptures(orgId, id, new Date(), access)).find(
          (entry) => entry.id === captureId,
        ) ?? null;
      return NextResponse.json({ capture });
    } catch (error) {
      // Receipt refusals and endpoint misconfiguration are typed 4xx with
      // their remedy; anything else is logged and answers 500.
      return apiErrorResponse(error);
    }
  },
});
