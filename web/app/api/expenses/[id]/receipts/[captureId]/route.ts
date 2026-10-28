import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { ReceiptCaptureRefusal } from "@openbooks/engine/payables/receipt-capture-service";
import { isUuid } from "../../../../../../lib/list-params";
import { authorizeExpenses, expenseAccess } from "../../../../../../lib/expense-access";
import { actOnExpenseReceiptCapture } from "../../../../../../lib/expense-receipt-actions";

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
    const access = await expenseAccess(gate, "edit");
    if (!access)
      return apiErrorResponse(
        new ReceiptCaptureRefusal(404, "not_found", "Expense report not found"),
      );
    return actOnExpenseReceiptCapture({
      gate,
      documentId: id,
      captureId,
      access,
      action: body.action,
    });
  },
});
