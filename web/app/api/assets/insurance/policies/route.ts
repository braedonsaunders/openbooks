import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { createInsurancePolicy } from "@openbooks/engine/assets/asset-insurance";
import { id, scopeOf } from "../../_depth";
import { policyFields } from "../_fields";

export const runtime = "nodejs";

/** Record an insurance policy for one legal entity's assets. */
export const POST = defineRoute({
  permission: "assets.maintain",
  feature: "assetInsurance",
  body: z.strictObject({ subsidiaryId: id, ...policyFields }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: input }) => {
    const created = await createInsurancePolicy(gate.user.orgId, input, {
      actorId: gate.user.id,
      allowedSubsidiaryIds: scopeOf(gate),
    });
    return NextResponse.json(created, { status: 201 });
  },
});
