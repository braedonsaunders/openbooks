import { NextResponse } from "next/server";
import { completePosSale } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { posSaleBody } from "@/lib/api/pos-schemas";
import { posAuthority, posIdempotencyKey, posPricing } from "@/lib/pos";

export const runtime = "nodejs";

/**
 * POST /api/pos/sales — complete a register sale. The `Idempotency-Key`
 * header (a UUID the register generates per receipt) becomes the cash
 * sale's id: a retried submit returns the sale already recorded (200)
 * instead of ringing it up twice; a new sale answers 201.
 */
export const POST = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  body: posSaleBody,
  handler: async ({ authz, body, request }) => {
    const key = posIdempotencyKey(request);
    if (!key)
      return NextResponse.json(
        {
          error: "The sale needs an Idempotency-Key header carrying a UUID.",
          code: "invalid_idempotency_key",
        },
        { status: 400 },
      );
    try {
      const completion = await completePosSale(
        {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          sessionId: body.sessionId,
          idempotencyKey: key,
          customerId: body.customerId ?? null,
          lines: body.lines,
          orderDiscount: body.orderDiscount ?? null,
          payments: body.payments,
          expectedTotal: body.expectedTotal ?? null,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
        },
        posAuthority(authz),
        posPricing,
      );
      return NextResponse.json(completion, { status: completion.replayed ? 200 : 201 });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
