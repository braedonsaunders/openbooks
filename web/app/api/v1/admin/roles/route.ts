import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationRoles } from "../../../../../lib/application/admin-read";

export const runtime = "nodejs";

/** GET /api/v1/admin/roles — roles with permission sets and member counts. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/admin/roles", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationRoles(context, {
        query: url.searchParams.get("q") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
