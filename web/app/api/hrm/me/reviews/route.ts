import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getMyReviewWorkspace } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../_lib";
/**
 * The caller's own review workspace: owed self-assessments, manager
 * reviews shared with them (calibration stripped), and their own goals.
 * An unshared manager review never appears — the privacy scope lives in
 * the engine read, never in this route.
 */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrm",
  handler: async ({ authz: gate }) => {
    try {
      const workspace = await getMyReviewWorkspace({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ workspace });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
