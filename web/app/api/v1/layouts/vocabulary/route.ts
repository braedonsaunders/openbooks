import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { describeLayoutVocabulary } from "../../../../../lib/application/page-layouts";

export const runtime = "nodejs";

/** GET /api/v1/layouts/vocabulary — the block/cell/widget/frame names a layout may use. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/vocabulary", async (_auth, context) => {
    return { status: 200, body: { ok: true, ...(await describeLayoutVocabulary(context)) } };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
