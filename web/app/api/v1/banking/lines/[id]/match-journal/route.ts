import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { matchStatementLineWithJournal } from "../../../../../../../lib/application/banking";

export const runtime = "nodejs";

/** POST /api/v1/banking/lines/:id/match-journal */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/lines/:id/match-journal", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    const outcome = await matchStatementLineWithJournal(context, {
      statementLineId: id,
      reconciliationId: String(body.reconciliationId ?? ""),
      offsetAccountId: String(body.offsetAccountId ?? ""),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
