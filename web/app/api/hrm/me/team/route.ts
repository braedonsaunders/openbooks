import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getTeamView } from "@openbooks/engine/src/hrm/self-service/team-read.ts";
import { meErrorResponse } from "../_lib";
/**
 * The caller's direct-report team as of today: roster, open steps assigned
 * to the manager, pending leave, and pending change requests. Structural —
 * a report-less caller is refused by name, never shown an empty team.
 * Decisions ride native Approvals; this read deep-links there.
 */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrm",
  handler: async ({ authz: gate }) => {
    try {
      const team = await getTeamView({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ team });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
