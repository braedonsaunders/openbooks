import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../../../lib/api/v1-request";
import { discardExtensionDraft } from "../../../../../../../lib/application/extensions";

const discardDraftBody = z.looseObject({ contentHash: z.string().min(1, "contentHash is required").optional() });

export const runtime = "nodejs";

/**
 * POST /api/v1/apps/drafts/[id]/discard — discard this author's unpublished
 * draft while preserving its source and audit evidence. Activated versions
 * cannot be discarded.
 */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/drafts/:id/discard", async (_auth, context) => {
    const { id } = await params;
    const body = discardDraftBody.parse(await readV1JsonObject(request));
    if (typeof body.contentHash !== "string" || !body.contentHash) {
      throw new ApplicationError("invalid_input", "contentHash is required", 422);
    }
    return { status: 200, body: { ok: true, ...(await discardExtensionDraft(context, { draftId: id, contentHash: body.contentHash })) } };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
