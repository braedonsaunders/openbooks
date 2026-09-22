import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { decideApproval } from "../../../../../lib/application/approvals";

export const runtime = "nodejs";

/** POST /api/v1/approvals/decide */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/approvals/decide", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const outcome = await decideApproval(context, {
      gateId: typeof body.gateId === "string" ? body.gateId : undefined,
      documentId: typeof body.documentId === "string" ? body.documentId : undefined,
      paymentRunId: typeof body.paymentRunId === "string" ? body.paymentRunId : undefined,
      decision: body.decision as "approved" | "rejected",
      comment: typeof body.comment === "string" ? body.comment : undefined,
      signature: typeof body.signature === "string" ? body.signature : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
