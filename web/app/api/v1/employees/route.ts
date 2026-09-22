import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationRoleParties } from "../../../../lib/application/party-read";

export const runtime = "nodejs";

/** GET /api/v1/employees — parties with an active employee role. Birth date and government ids are never returned. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/employees", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationRoleParties(context, {
        role: "employee",
        query: url.searchParams.get("q") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
