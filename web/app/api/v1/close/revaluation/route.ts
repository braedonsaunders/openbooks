import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { runPeriodRevaluation } from "../../../../../lib/application/close";

const runPeriodRevaluationBody = z.looseObject({
  periodId: z.string().min(1),
  bookId: z.string().min(1).optional(),
});

export const runtime = "nodejs";

/** POST /api/v1/close/revaluation */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/revaluation", async (_auth, context) => {
    const body = runPeriodRevaluationBody.parse(await readV1JsonObject(request));
    const outcome = await runPeriodRevaluation(context, {
      periodId: body.periodId,
      bookId: body.bookId,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
