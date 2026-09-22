import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../../lib/api/v1-request";
import { getExtensionDraft } from "../../../../../../lib/application/extensions";

export const runtime = "nodejs";

/** GET /api/v1/apps/drafts/[id] — read this author's exact unpublished package. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/drafts/:id", async (_auth, context) => {
    const { id } = await params;
    return { status: 200, body: { ok: true, draft: await getExtensionDraft(context, id) } };
  });
}
