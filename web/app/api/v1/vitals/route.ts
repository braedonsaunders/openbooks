import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { orgVitals } from "../../../../lib/application/vitals";

export const runtime = "nodejs";

/** GET /api/v1/vitals — cash, aging, approvals, and close snapshot. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/vitals", async (_auth, context) => {
    return { status: 200, body: await orgVitals(context) };
  });
}
