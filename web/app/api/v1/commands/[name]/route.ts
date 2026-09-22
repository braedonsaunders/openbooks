import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import {
  applicationTool,
  executeApplicationTool,
} from "../../../../../lib/application/tool-catalog";
import { applicationToolVisible } from "../../../../../lib/assistant/registry";
import { resolvedFeatureState } from "../../../../../lib/features";

export const runtime = "nodejs";

/**
 * POST /api/v1/commands/[name] — the same application command MCP executes.
 * Mutations already require an idempotency key inside the tool schema; the
 * header is accepted as the same key when the body omitted it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/commands/:name", async (auth, context) => {
    const { name } = await params;
    const definition = applicationTool(name);
    if (!definition) {
      throw new ApplicationError("not_found", `command ${name} is not in the application catalog`, 404);
    }
    const features = await resolvedFeatureState(auth.user.orgId);
    if (!applicationToolVisible(definition, context.authz, features)) {
      throw new ApplicationError("forbidden", "forbidden", 403);
    }
    const body = await readV1JsonObject(request);
    if (!definition.readOnly && typeof body.idempotencyKey !== "string") {
      body.idempotencyKey = requireV1IdempotencyKey(request);
    }
    const result = await executeApplicationTool(definition, context, body);
    return { status: 200, body: result };
  });
}
