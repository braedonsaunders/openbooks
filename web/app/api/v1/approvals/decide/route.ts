import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { decideApproval } from "../../../../../lib/application/approvals";

const decideApprovalBody = z.looseObject({
  gateId: z.string().optional(),
  documentId: z.string().optional(),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().optional(),
  signature: z.string().optional(),
});

export const runtime = "nodejs";

/** POST /api/v1/approvals/decide */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/approvals/decide", async (_auth, context) => {
    const body = decideApprovalBody.parse(await readV1JsonObject(request));
    const outcome = await decideApproval(context, {
      gateId: typeof body.gateId === "string" ? body.gateId : undefined,
      documentId: typeof body.documentId === "string" ? body.documentId : undefined,
      decision: body.decision as "approved" | "rejected",
      comment: typeof body.comment === "string" ? body.comment : undefined,
      signature: typeof body.signature === "string" ? body.signature : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
