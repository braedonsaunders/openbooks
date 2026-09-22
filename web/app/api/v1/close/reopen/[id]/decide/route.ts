import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { decideReopenRequest } from "../../../../../../../lib/application/close";

export const runtime = "nodejs";

/** POST /api/v1/close/reopen/:id/decide */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/reopen/:id/decide", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    const outcome = await decideReopenRequest(context, {
      requestId: id,
      approve: body.approve === true,
      hours: typeof body.hours === "number" ? body.hours : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
