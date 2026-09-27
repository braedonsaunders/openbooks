import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApprovalWorklist } from "../../../../lib/application/approvals";

export const runtime = "nodejs";

/** GET /api/v1/approvals — the actor's current approval worklist. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/approvals", async (_auth, context) => {
    return { status: 200, body: { approvals: await listApprovalWorklist(context) } };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
