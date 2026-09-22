import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { describeLayoutVocabulary } from "../../../../../lib/application/page-layouts";

export const runtime = "nodejs";

/** GET /api/v1/layouts/vocabulary — the block/cell/widget/frame names a layout may use. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/vocabulary", async (_auth, context) => {
    return { status: 200, body: { ok: true, ...(await describeLayoutVocabulary(context)) } };
  });
}
