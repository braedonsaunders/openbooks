import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { unmatchStatementLineAction } from "../../../../../../../lib/application/banking";

const unmatchStatementLineBody = z.looseObject({ reconciliationId: z.string().min(1) });

export const runtime = "nodejs";

/** POST /api/v1/banking/lines/:id/unmatch */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/lines/:id/unmatch", async (_auth, context) => {
    const { id } = await params;
    const body = unmatchStatementLineBody.parse(await readV1JsonObject(request));
    const outcome = await unmatchStatementLineAction(context, {
      statementLineId: id,
      reconciliationId: String(body.reconciliationId ?? ""),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
