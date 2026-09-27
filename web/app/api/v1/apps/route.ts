import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listExtensions } from "../../../../lib/application/extensions";

export const runtime = "nodejs";

/** GET /api/v1/apps — this organization's app packages and active versions. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps", async (_auth, context) => {
    return { status: 200, body: { ok: true, ...(await listExtensions(context)) } };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
