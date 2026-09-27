import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationBudgets } from "../../../../lib/application/budgets";

export const runtime = "nodejs";

/** GET /api/v1/budgets — non-archived budget and forecast scenarios. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/budgets", async (_auth, context) => ({
    status: 200,
    body: await listApplicationBudgets(context),
  }));
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
