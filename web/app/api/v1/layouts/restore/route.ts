import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../lib/api/v1-request";
import { restoreLayout } from "../../../../../lib/application/page-layouts";

const restoreLayoutBody = z.looseObject({
  route: z.unknown().optional(),
  versionId: z.unknown().optional(),
});

export const runtime = "nodejs";

/**
 * POST /api/v1/layouts/restore — republish a past layout version by history
 * id. Appends a new active version; history stays a true live-record.
 */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/restore", async (_auth, context) => {
    const body = restoreLayoutBody.parse(await readV1JsonObject(request));
    if (typeof body.route !== "string" || !body.route) {
      throw new ApplicationError("invalid_input", "route is required", 422);
    }
    if (typeof body.versionId !== "string" || !body.versionId) {
      throw new ApplicationError("invalid_input", "versionId is required", 422);
    }
    return { status: 200, body: { ok: true, ...(await restoreLayout(context, { route: body.route, versionId: body.versionId })) } };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
