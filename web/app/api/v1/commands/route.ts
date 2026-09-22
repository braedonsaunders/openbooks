import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { APPLICATION_TOOLS } from "../../../../lib/application/tool-catalog";
import { applicationToolVisible } from "../../../../lib/assistant/registry";
import { resolvedFeatureState } from "../../../../lib/features";

export const runtime = "nodejs";

/** GET /api/v1/commands — the application catalog visible to this API key. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/commands", async (auth, context) => {
    const features = await resolvedFeatureState(auth.user.orgId);
    const commands = APPLICATION_TOOLS
      .filter((definition) => applicationToolVisible(definition, context.authz, features))
      .map((definition) => ({
        name: definition.name,
        title: definition.title,
        description: definition.description,
        readOnly: definition.readOnly,
        destructive: definition.destructive,
        href: `/api/v1/commands/${definition.name}`,
      }));
    return { status: 200, body: { commands } };
  });
}
