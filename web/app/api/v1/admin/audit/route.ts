import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationAuditEvents } from "../../../../../lib/application/admin-read";

export const runtime = "nodejs";

/** GET /api/v1/admin/audit — company audit log. Restricted subsidiary callers are refused by name. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/admin/audit", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationAuditEvents(context, {
        query: url.searchParams.get("q") ?? undefined,
        action: url.searchParams.get("action") ?? undefined,
        recordType: url.searchParams.get("recordType") ?? undefined,
        actorId: url.searchParams.get("actorId") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
