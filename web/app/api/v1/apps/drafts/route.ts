import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../lib/api/v1-request";
import { draftExtension } from "../../../../../lib/application/extensions";

export const runtime = "nodejs";

/**
 * POST /api/v1/apps/drafts — save an immutable unpublished app package (no
 * install, objects, execution, or activation). Same command as the
 * `draft_app` application tool; revisions are new drafts.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/drafts", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    if (body.bundle === undefined) {
      throw new ApplicationError("invalid_input", "bundle is required", 422);
    }
    if (typeof body.reason !== "string" || !body.reason.trim()) {
      throw new ApplicationError("invalid_input", "reason is required", 422);
    }
    const result = await draftExtension(context, {
      bundle: body.bundle,
      reason: body.reason,
      expectedBaseVersionId: typeof body.expectedBaseVersionId === "string" || body.expectedBaseVersionId === null
        ? body.expectedBaseVersionId
        : undefined,
      sourceDraft: body.sourceDraft && typeof body.sourceDraft === "object" && !Array.isArray(body.sourceDraft)
        ? body.sourceDraft as { id: string; contentHash: string }
        : undefined,
    });
    return { status: 201, body: { ok: true, ...result } };
  });
}
