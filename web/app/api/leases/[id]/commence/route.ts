import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { LeaseError } from "@openbooks/engine/src/revenue/leases.ts";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/list-params";
import { commenceLease } from "@openbooks/engine/src/revenue/leases.ts";
export { runtime } from "@/lib/api/route";
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid lease" }, { status: 422 });

    try {
      return NextResponse.json(
        await commenceLease(gate.user.orgId, id, gate.user.id),
      );
    } catch (e) {
      if (e instanceof LeaseError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      return apiErrorResponse(e);
    }
  },
});
