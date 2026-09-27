import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../lib/api/v1-request";
import { postPayment } from "../../../../../../lib/application/payments";

const paymentAllocationBody = z.looseObject({
  openLineId: z.string().min(1),
  sourceTransactionAmount: z.string().min(1),
  targetTransactionAmount: z.string().min(1),
  targetBaseAmount: z.string().min(1).optional(),
  settlementRate: z.string().min(1),
  settlementRateSource: z.enum(["same_currency", "provider", "manual", "contractual", "imported"]),
  settlementRateReference: z.string().trim().min(1).max(500),
  settlementFxRateId: z.string().nullable().optional(),
});
const postPaymentBody = z.looseObject({ allocations: z.array(paymentAllocationBody).min(1).max(1000).optional() });

export const runtime = "nodejs";

/** POST /api/v1/payments/:id/post — submit and post with open-item applications. */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payments/:id/post", async (_auth, context) => {
    const { id } = await params;
    const body = postPaymentBody.parse(await readV1JsonObject(request));
    const outcome = await postPayment(context, {
      documentId: id,
      allocations: body.allocations as never,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
