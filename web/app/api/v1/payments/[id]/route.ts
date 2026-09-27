import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { v1GetRecord } from "../../../../../lib/api/v1-records";
import { updatePayment } from "../../../../../lib/application/payments";

const updatePaymentRequestBody = z.looseObject({
  patch: z.record(z.string(), z.unknown()).optional(),
});

export const runtime = "nodejs";

/** GET /api/v1/payments/:id — read one payment or receipt document. */
async function handleV1GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return v1GetRecord(request, "payments", id, "api/v1/payments/:id");
}

/** PATCH /api/v1/payments/:id — update a draft payment and its allocations. */
async function handleV1PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payments/:id", async (_auth, context) => {
    const { id } = await params;
    const body = updatePaymentRequestBody.parse(await readV1JsonObject(request));
    const outcome = await updatePayment(context, {
      documentId: id,
      patch: (body.patch ?? body) as never,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1GET(request, { params: Promise.resolve(params as never) } as never),
});

export const PATCH = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1PATCH(request, { params: Promise.resolve(params as never) } as never),
});
