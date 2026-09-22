import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../../../lib/api/v1-request";
import { activateExtensionDraft } from "../../../../../../../lib/application/extensions";

export const runtime = "nodejs";

/**
 * POST /api/v1/apps/drafts/[id]/activate — activate the exact reviewed,
 * approved author draft (binds draft id and contentHash). Refuses stale bases
 * or missing permissions; the commit is atomic.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/drafts/:id/activate", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    if (typeof body.contentHash !== "string" || !body.contentHash) {
      throw new ApplicationError("invalid_input", "contentHash is required", 422);
    }
    return { status: 200, body: { ok: true, ...(await activateExtensionDraft(context, { draftId: id, contentHash: body.contentHash })) } };
  });
}
