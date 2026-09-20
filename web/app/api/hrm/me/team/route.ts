import { NextResponse } from "next/server";
import { getTeamView } from "@openbooks/engine/src/hrm/self-service/team-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";

export const runtime = "nodejs";

/**
 * The caller's direct-report team as of today: roster, open steps assigned
 * to the manager, pending leave, and pending change requests. Structural —
 * a report-less caller is refused by name, never shown an empty team.
 * Decisions ride native Approvals; this read deep-links there.
 */
export async function GET() {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const team = await getTeamView({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ team });
  } catch (e) {
    return meErrorResponse(e);
  }
}
