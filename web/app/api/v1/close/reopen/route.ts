import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { createReopenRequest, listPeriodReopenRequests } from "../../../../../lib/application/close";

export const runtime = "nodejs";

/** GET /api/v1/close/reopen — reopen queue. Restricted subsidiary callers are refused by name. */
export async function GET(request: Request): Promise<NextResponse> {
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
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/reopen", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const outcome = await createReopenRequest(context, {
      periodId: String(body.periodId ?? ""),
      bookId: String(body.bookId ?? ""),
      subsidiaryId: typeof body.subsidiaryId === "string" ? body.subsidiaryId : undefined,
      modules: Array.isArray(body.modules) ? body.modules as never : [],
      reason: String(body.reason ?? ""),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
