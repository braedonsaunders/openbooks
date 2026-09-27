import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationOpportunities } from "../../../../lib/application/crm-read";

export const runtime = "nodejs";

/** GET /api/v1/opportunities — sales opportunities. Amounts are exact decimal strings. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/opportunities", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const openOnly = url.searchParams.get("openOnly");
    return {
      status: 200,
      body: await listApplicationOpportunities(context, {
        query: url.searchParams.get("q") ?? undefined,
        openOnly: openOnly === "true" || openOnly === "1",
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
