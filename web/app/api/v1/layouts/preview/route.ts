import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../../lib/api/v1-request";
import { previewLayout } from "../../../../../lib/application/page-layouts";

const previewLayoutBody = z.looseObject({
  route: z.unknown().optional(),
  spec: z.unknown().optional(),
  params: z.unknown().optional(),
});

export const runtime = "nodejs";

/**
 * POST /api/v1/layouts/preview — stage a draft layout for a private expiring
 * preview url. Staging changes nothing for anyone else; publishing is PUT
 * /api/v1/layouts.
 */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/preview", async (_auth, context) => {
    const body = previewLayoutBody.parse(await readV1JsonObject(request));
    if (typeof body.route !== "string" || !body.route) {
      throw new ApplicationError("invalid_input", "route is required", 422);
    }
    if (body.spec === undefined) {
      throw new ApplicationError("invalid_input", "spec is required", 422);
    }
    let params: Record<string, string> | undefined;
    if (body.params !== undefined) {
      if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
        throw new ApplicationError("invalid_input", "params must be an object of string values", 422);
      }
      params = {};
      for (const [key, entry] of Object.entries(body.params as Record<string, unknown>)) {
        if (typeof entry !== "string") {
          throw new ApplicationError("invalid_input", "params must be an object of string values", 422);
        }
        params[key] = entry;
      }
    }
    return { status: 200, body: { ok: true, ...(await previewLayout(context, { route: body.route, spec: body.spec, params })) } };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
