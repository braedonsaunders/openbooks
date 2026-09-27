import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getMyBenefitsWorkspace } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../_lib";
/**
 * The caller's own benefits: elections with the stored payroll amounts,
 * the open windows covering their employer, dependents on file, and the
 * plans offered to their subsidiary. Amounts are the stored per-period
 * figures — never recomputed here.
 */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrm",
  handler: async ({ authz: gate }) => {
    try {
      const workspace = await getMyBenefitsWorkspace({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ workspace });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
