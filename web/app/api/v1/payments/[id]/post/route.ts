import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../lib/api/v1-request";
import { postPayment } from "../../../../../../lib/application/payments";

export const runtime = "nodejs";

/** POST /api/v1/payments/:id/post — submit and post with open-item applications. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payments/:id/post", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    const outcome = await postPayment(context, {
      documentId: id,
      allocations: Array.isArray(body.allocations) ? body.allocations as never : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
