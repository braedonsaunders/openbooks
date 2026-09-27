import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import {
  listApplicationReconciliations,
  startReconciliationSession,
} from "../../../../../lib/application/banking";

const startReconciliationBody = z.looseObject({
  accountId: z.string().min(1),
  throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  statementBalance: z.string().min(1),
});

export const runtime = "nodejs";

/** GET /api/v1/banking/reconciliations — sessions scoped to the caller's subsidiaries. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/reconciliations", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationReconciliations(context, {
        accountId: url.searchParams.get("accountId") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}

/** POST /api/v1/banking/reconciliations */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/reconciliations", async (_auth, context) => {
    const body = startReconciliationBody.parse(await readV1JsonObject(request));
    const outcome = await startReconciliationSession(context, {
      accountId: body.accountId,
      throughDate: body.throughDate,
      statementBalance: body.statementBalance,
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
