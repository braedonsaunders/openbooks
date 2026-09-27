import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { decideReopenRequest } from "../../../../../../../lib/application/close";

const decideReopenBody = z.looseObject({
  approve: z.boolean(),
  hours: z.number().finite().nonnegative().optional(),
});

export const runtime = "nodejs";

/** POST /api/v1/close/reopen/:id/decide */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/reopen/:id/decide", async (_auth, context) => {
    const { id } = await params;
    const body = decideReopenBody.parse(await readV1JsonObject(request));
    const outcome = await decideReopenRequest(context, {
      requestId: id,
      approve: body.approve,
      hours: body.hours,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
