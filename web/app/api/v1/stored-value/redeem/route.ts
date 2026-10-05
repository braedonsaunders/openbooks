import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { redeemStoredValueForInvoice } from "../../../../../lib/application/stored-value";

const redeemBody = z.looseObject({
  code: z.string().min(1).max(64),
  amount: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
  invoiceId: z.string().uuid(),
});

export const runtime = "nodejs";

/**
 * POST /api/v1/stored-value/redeem — redeem a gift card or store credit
 * against one invoice, for storefront/POS use. Exactly-once per
 * Idempotency-Key: the receipt posts through the payment kernel, so the
 * books stay balanced through the ordinary customer_payment path.
 */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/stored-value/redeem", async (_auth, context) => {
    const raw = await readV1JsonObject(request);
    const body = redeemBody.parse(raw);
    const outcome = await redeemStoredValueForInvoice(context, {
      code: body.code,
      amount: body.amount,
      invoiceId: body.invoiceId,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.result.status === "posted" ? 201 : 202, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
