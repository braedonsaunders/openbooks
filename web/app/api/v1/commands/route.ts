import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { APPLICATION_TOOLS } from "../../../../lib/application/tool-catalog";
import { applicationToolVisible } from "../../../../lib/assistant/registry";
import { resolvedFeatureState } from "../../../../lib/features";

export const runtime = "nodejs";

/** The command's request body as JSON Schema, the same contract MCP clients receive. */
function inputJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return null;
  }
}

/** GET /api/v1/commands — the application catalog visible to this API key, with each command's input schema. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/commands", async (auth, context) => {
    const features = await resolvedFeatureState(auth.user.orgId);
    const commands = APPLICATION_TOOLS.filter((definition) =>
      applicationToolVisible(definition, context.authz, features),
    ).map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      readOnly: definition.readOnly,
      destructive: definition.destructive,
      href: `/api/v1/commands/${definition.name}`,
      inputSchema: inputJsonSchema(definition.inputSchema),
    }));
    return { status: 200, body: { commands } };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
