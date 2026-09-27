import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getMySteps } from "@openbooks/engine/src/hrm/self-service/self-read.ts";
import { meErrorResponse } from "../_lib";
/**
 * The caller's own open checklist steps. Completion rides the existing
 * step endpoint — this read names the rows, never completes them.
 */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrm",
  handler: async ({ authz: gate }) => {
    try {
      const steps = await getMySteps({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ steps });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
