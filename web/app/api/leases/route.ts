import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { LeaseError } from "@openbooks/engine/src/revenue/leases.ts";
import { NextResponse } from "next/server";
import { createLeaseAgreement } from "@openbooks/engine/src/revenue/leases.ts";
import { leaseSchema } from "./_schema";
export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  body: leaseSchema,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    try {
      return NextResponse.json(
        await createLeaseAgreement(gate.user.orgId, gate.user.id, routeBody),
      );
    } catch (e) {
      if (e instanceof LeaseError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      return apiErrorResponse(e);
    }
  },
});
