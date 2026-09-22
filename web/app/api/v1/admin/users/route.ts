import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationUsers } from "../../../../../lib/application/admin-read";

export const runtime = "nodejs";

/** GET /api/v1/admin/users — company users. Never credentials. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/admin/users", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationUsers(context, {
        query: url.searchParams.get("q") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
