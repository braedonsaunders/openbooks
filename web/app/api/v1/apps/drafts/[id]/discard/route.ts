import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../../../lib/api/v1-request";
import { discardExtensionDraft } from "../../../../../../../lib/application/extensions";

export const runtime = "nodejs";

/**
 * POST /api/v1/apps/drafts/[id]/discard — discard this author's unpublished
 * draft while preserving its source and audit evidence. Activated versions
 * cannot be discarded.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/drafts/:id/discard", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    if (typeof body.contentHash !== "string" || !body.contentHash) {
      throw new ApplicationError("invalid_input", "contentHash is required", 422);
    }
    return { status: 200, body: { ok: true, ...(await discardExtensionDraft(context, { draftId: id, contentHash: body.contentHash })) } };
  });
}
