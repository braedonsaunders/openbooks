import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { matchStatementLine } from "../../../../../../../lib/application/banking";

export const runtime = "nodejs";

/** POST /api/v1/banking/lines/:id/match */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/lines/:id/match", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    const outcome = await matchStatementLine(context, {
      statementLineId: id,
      reconciliationId: String(body.reconciliationId ?? ""),
      journalLineIds: Array.isArray(body.journalLineIds)
        ? body.journalLineIds.filter((lineId): lineId is string => typeof lineId === "string")
        : [],
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
