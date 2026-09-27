import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { matchStatementLine } from "../../../../../../../lib/application/banking";

const matchStatementLineBody = z.looseObject({
  reconciliationId: z.string().min(1),
  journalLineIds: z.array(z.string().min(1)).min(1).max(50),
});

export const runtime = "nodejs";

/** POST /api/v1/banking/lines/:id/match */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/lines/:id/match", async (_auth, context) => {
    const { id } = await params;
    const body = matchStatementLineBody.parse(await readV1JsonObject(request));
    const outcome = await matchStatementLine(context, {
      statementLineId: id,
      reconciliationId: String(body.reconciliationId ?? ""),
      journalLineIds: body.journalLineIds,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
