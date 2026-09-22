import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationCrmAccounts } from "../../../../../lib/application/crm-read";

export const runtime = "nodejs";

/** GET /api/v1/crm/accounts — CRM accounts across the lead → customer lifecycle. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/crm/accounts", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationCrmAccounts(context, {
        query: url.searchParams.get("q") ?? undefined,
        stage: url.searchParams.get("stage") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
