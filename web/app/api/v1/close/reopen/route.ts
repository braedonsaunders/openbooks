import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { createReopenRequest, listPeriodReopenRequests } from "../../../../../lib/application/close";

const createReopenRequestBody = z.looseObject({
  periodId: z.string().min(1),
  bookId: z.string().min(1),
  subsidiaryId: z.string().optional(),
  modules: z.array(z.enum(["ar", "ap", "banking", "assets", "tax", "gl"])).optional(),
  reason: z.string(),
});

export const runtime = "nodejs";

/** GET /api/v1/close/reopen — reopen queue. Restricted subsidiary callers are refused by name. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/reopen", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listPeriodReopenRequests(context, {
        status: url.searchParams.get("status") ?? undefined,
        periodId: url.searchParams.get("periodId") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}

/** POST /api/v1/close/reopen — request a controlled reopen of a hard-closed scope. */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/reopen", async (_auth, context) => {
    const body = createReopenRequestBody.parse(await readV1JsonObject(request));
    const outcome = await createReopenRequest(context, {
      periodId: body.periodId,
      bookId: body.bookId,
      subsidiaryId: body.subsidiaryId,
      modules: body.modules ?? [],
      reason: body.reason,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
