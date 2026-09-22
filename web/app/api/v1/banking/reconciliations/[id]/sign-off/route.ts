import { NextResponse } from "next/server";
import { requireV1IdempotencyKey, withV1Request } from "../../../../../../../lib/api/v1-request";
import { signOffReconciliation } from "../../../../../../../lib/application/banking";

export const runtime = "nodejs";

/** POST /api/v1/banking/reconciliations/:id/sign-off */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/reconciliations/:id/sign-off", async (_auth, context) => {
    const { id } = await params;
    const outcome = await signOffReconciliation(context, {
      reconciliationId: id,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
