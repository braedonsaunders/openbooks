import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { submitReopenRequest } from "../../../../../../../lib/application/close";

const submitReopenBody = z.strictObject({
  hours: z.number().finite().nonnegative().optional(),
});

export const runtime = "nodejs";

/** POST /api/v1/close/reopen/:id/submit */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/reopen/:id/submit", async (_auth, context) => {
    const { id } = await params;
    const body = submitReopenBody.parse(await readV1JsonObject(request));
    const outcome = await submitReopenRequest(context, {
      requestId: id,
      hours: body.hours,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) =>
    handleV1POST(request, {
      params: Promise.resolve(params as never),
    } as never),
});
