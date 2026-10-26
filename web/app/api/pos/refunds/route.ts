import { NextResponse } from "next/server";
import { completePosRefund } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { posRefundBody } from "@/lib/api/pos-schemas";
import { posIdempotencyKey } from "@/lib/pos";

export const runtime = "nodejs";

/**
 * POST /api/pos/refunds — refund lines of a prior receipt as a native cash
 * refund at the original prices and tax, paid out of the open session. The
 * `Idempotency-Key` header makes a retried refund return the refund already
 * recorded.
 */
export const POST = defineRoute({
  permission: "pos.refund",
  feature: "posRegister",
  body: posRefundBody,
  handler: async ({ authz, body, request }) => {
    const key = posIdempotencyKey(request);
    if (!key)
      return NextResponse.json(
        {
          error: "The refund needs an Idempotency-Key header carrying a UUID.",
          code: "invalid_idempotency_key",
        },
        { status: 400 },
      );
    try {
      const completion = await completePosRefund({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        sessionId: body.sessionId,
        idempotencyKey: key,
        originalDocumentId: body.originalDocumentId,
        lines: body.lines,
        payments: body.payments,
        reason: body.reason ?? null,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      });
      return NextResponse.json(completion, { status: completion.replayed ? 200 : 201 });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
