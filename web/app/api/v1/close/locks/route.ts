import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listPeriodLocks } from "../../../../../lib/application/close";

export const runtime = "nodejs";

/** GET /api/v1/close/locks — period locks. Restricted subsidiary callers are refused by name. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/locks", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listPeriodLocks(context, {
        periodId: url.searchParams.get("periodId") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        module: url.searchParams.get("module") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
