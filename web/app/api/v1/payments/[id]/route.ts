import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { updatePayment } from "../../../../../lib/application/payments";

export const runtime = "nodejs";

/** PATCH /api/v1/payments/:id — update a draft payment and its allocations. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payments/:id", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    const outcome = await updatePayment(context, {
      documentId: id,
      patch: (body.patch ?? body) as never,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
