import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../lib/api/v1-request";
import { validateLayout } from "../../../../../lib/application/page-layouts";

const validateLayoutBody = z.looseObject({ spec: z.unknown().optional() });

export const runtime = "nodejs";

/** POST /api/v1/layouts/validate — check a draft layout without storing it. */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/validate", async (_auth, context) => {
    const body = validateLayoutBody.parse(await readV1JsonObject(request));
    if (body.spec === undefined) {
      throw new ApplicationError("invalid_input", "spec is required", 422);
    }
    return { status: 200, body: { ok: true, ...(await validateLayout(context, { spec: body.spec })) } };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
