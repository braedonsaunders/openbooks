import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationReports } from "../../../../lib/application/reports";

export const runtime = "nodejs";

/** GET /api/v1/reports — saved report definitions this API key may run. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/reports", async (_auth, context) => {
    const url = new URL(request.url);
    return {
      status: 200,
      body: await listApplicationReports(context, {
        query: url.searchParams.get("q")?.trim() || undefined,
      }),
    };
  });
}
