import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { reverseSourceManagedDepreciation } from "@openbooks/engine/assets/depreciation-reversal";

export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: uuidString() }),
  body: z.strictObject({ lineId: uuidString(), reason: z.string().trim().min(8).max(500) }),
  handler: async ({ authz, params, body }) => {
    try {
      return NextResponse.json(
        await reverseSourceManagedDepreciation({
          orgId: authz.user.orgId,
          assetId: params.id,
          lineId: body.lineId,
          actorId: authz.user.id,
          reason: body.reason,
        }),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
