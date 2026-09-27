import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../lib/application/errors";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listLayoutHistory } from "../../../../../lib/application/page-layouts";

export const runtime = "nodejs";

/** GET /api/v1/layouts/history?route= — every layout ever saved for a route, newest first. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/history", async (_auth, context) => {
    const route = new URL(request.url).searchParams.get("route") ?? "";
    if (!route) {
      throw new ApplicationError("invalid_input", "route query parameter is required", 422);
    }
    return { status: 200, body: { ok: true, ...(await listLayoutHistory(context, { route })) } };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
