import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { startReconciliationSession } from "../../../../../lib/application/banking";

export const runtime = "nodejs";

/** POST /api/v1/banking/reconciliations */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/reconciliations", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const outcome = await startReconciliationSession(context, {
      accountId: String(body.accountId ?? ""),
      throughDate: String(body.throughDate ?? ""),
      statementBalance: String(body.statementBalance ?? ""),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
