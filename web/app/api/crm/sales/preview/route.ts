import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { isFeatureEnabled } from "@/lib/features";
import { SalesError } from "@openbooks/engine/crm/sales";
import { hasGeographicCoverage } from "@openbooks/engine/crm/sales/contracts";
import { db } from "@openbooks/engine/platform/database";
import { previewTerritory } from "@openbooks/engine/crm/sales";
import { salesTerritorySchema } from "@/lib/crm/sales-schema";
import { canonicalizeSalesGeography } from "@/lib/crm/territory-boundaries";

export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "crm.setup.manage",
  feature: "salesManagement",
  body: salesTerritorySchema,
  invalidBodyStatus: 422,
  maxBodyBytes: 8 * 1024 * 1024,
  handler: async ({ authz, body }) => {
    if (
      (hasGeographicCoverage(body.geography) ||
        body.geography.excludes.length) &&
      !(await isFeatureEnabled(authz.user.orgId, "geographicTerritories"))
    )
      throw new SalesError(
        "Enable Geographic territories in Company Settings → Features before previewing map coverage.",
        404,
      );
    const geography = await canonicalizeSalesGeography(body.geography);
    const result = await db.transaction((tx) =>
      previewTerritory(
        tx,
        {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        },
        { ...body, geography },
      ),
    );
    return NextResponse.json(result);
  },
});
