import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { runPeriodRevaluation } from "../../../../../lib/application/close";

export const runtime = "nodejs";

/** POST /api/v1/close/revaluation */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/revaluation", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const outcome = await runPeriodRevaluation(context, {
      periodId: String(body.periodId ?? ""),
      bookId: typeof body.bookId === "string" ? body.bookId : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
