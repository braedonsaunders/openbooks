import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { buildSource, getConnection } from "@openbooks/engine/sync/connection";
import { connectorSettings } from "@openbooks/engine/sync/connection-settings";
import { connectionConfigUrlRefusal } from "../../_connector-guard";

export const runtime = "nodejs";
export const maxDuration = 60;
const querySchema = z.object({
  field: z.string().min(1).max(120),
  parent: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,119}$/i)
    .optional(),
});

/** Credentials and source metadata remain behind the organization's configuration permission. */
export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Connector configuration is organization setup and has no separate feature gate.",
  },
  scope: "unrestricted",
  params: z.object({ id: uuidString() }),
  handler: async ({ request, params: { id }, authz }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success)
      return NextResponse.json(
        { error: "Choose a supported mapping field and parent record" },
        { status: 422 },
      );
    const row = await getConnection(authz.user.orgId, id);
    if (!row) return notFound("record");
    const field = connectorSettings(row.source)
      .mappingGroups.flatMap((group) => group.fields)
      .find((field) => field.key === query.data.field);
    if (!field || (field.requires && !query.data.parent) || (!field.requires && query.data.parent))
      return NextResponse.json(
        { error: "Choose a supported mapping field and its required parent record" },
        { status: 422 },
      );
    const urlError = await connectionConfigUrlRefusal(row.config);
    if (urlError) return NextResponse.json({ error: urlError }, { status: 422 });
    try {
      const source = buildSource(row);
      if (!source.mappingOptions)
        return NextResponse.json(
          {
            error:
              "This connector maps standard records automatically and has no custom-field choices",
          },
          { status: 422 },
        );
      return NextResponse.json(await source.mappingOptions(field.key, query.data.parent));
    } catch (cause) {
      // Source choices come straight from the connector adapter, so its
      // errors are untrusted: they answer the static fallback while the
      // cause stays in the server log.
      console.error("[platform/connections] mapping options failed", cause);
      return NextResponse.json(
        {
          error:
            "Source mapping choices are unavailable; check the connection's read permissions and retry",
        },
        { status: 422 },
      );
    }
  },
});
