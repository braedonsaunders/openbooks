import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationBudgets } from "../../../../lib/application/budgets";

export const runtime = "nodejs";

/** GET /api/v1/budgets — non-archived budget and forecast scenarios. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/budgets", async (_auth, context) => ({
    status: 200,
    body: await listApplicationBudgets(context),
  }));
}
