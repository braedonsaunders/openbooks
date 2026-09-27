import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { searchApplication } from "../../../../lib/application/search-read";

export const runtime = "nodejs";

/** GET /api/v1/search?q=... — global grouped search for allocation lookups. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/search", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await searchApplication(context, {
        q: url.searchParams.get("q") ?? "",
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
