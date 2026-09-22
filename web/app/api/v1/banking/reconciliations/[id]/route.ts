import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../../lib/api/v1-request";
import { getApplicationReconciliation } from "../../../../../../lib/application/banking";

export const runtime = "nodejs";

/** GET /api/v1/banking/reconciliations/{id} — one session's workspace/sign-off totals. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/reconciliations/[id]", async (_auth, context) => {
    const { id } = await params;
    return { status: 200, body: await getApplicationReconciliation(context, id) };
  });
}
