import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { describeExtensionVocabulary } from "../../../../../lib/application/extensions";

export const runtime = "nodejs";

/** GET /api/v1/apps/vocabulary — the app capability contract and draft → preview → approve workflow. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/vocabulary", async (_auth, context) => {
    return { status: 200, body: { ok: true, ...(await describeExtensionVocabulary(context)) } };
  });
}
