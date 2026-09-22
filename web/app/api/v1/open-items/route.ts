import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationOpenItems } from "../../../../lib/application/open-items";

export const runtime = "nodejs";

/** GET /api/v1/open-items?side=ar|ap — unpaid/unapplied items for allocation. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/open-items", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationOpenItems(context, {
        side: url.searchParams.get("side") ?? "",
        asOf: url.searchParams.get("asOf") ?? undefined,
        partyId: url.searchParams.get("partyId") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
