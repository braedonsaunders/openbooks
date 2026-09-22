import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationTrialBalance } from "../../../../lib/application/trial-balance-read";

export const runtime = "nodejs";

/** GET /api/v1/trial-balance?asOf=YYYY-MM-DD — same trialBalance reader as the TB report. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/trial-balance", async (_auth, context) => {
    const url = new URL(request.url);
    return {
      status: 200,
      body: await listApplicationTrialBalance(context, {
        asOf: url.searchParams.get("asOf") ?? "",
      }),
    };
  });
}
