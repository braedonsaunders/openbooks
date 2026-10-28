import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { verifyCrmTerritoryLocation } from "@/lib/crm/territory-location";

export const runtime = "nodejs";
export const PATCH = defineRoute({
  permission: "crm.accounts.manage",
  feature: "geographicTerritories",
  params: z.object({ id: uuidString() }),
  body: z.strictObject({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    expectedRevision: z.string(),
    reason: z.string().trim().min(1).max(1000),
  }),
  handler: async ({ authz, params, body }) => {
    await verifyCrmTerritoryLocation(authz, params.id, body);
    return NextResponse.json({ ok: true });
  },
});
