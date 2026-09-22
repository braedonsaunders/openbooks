import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationRoleParties } from "../../../../lib/application/party-read";

export const runtime = "nodejs";

/** GET /api/v1/vendors — parties with an active vendor role. Taxpayer ids are never returned. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/vendors", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationRoleParties(context, {
        role: "vendor",
        query: url.searchParams.get("q") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
