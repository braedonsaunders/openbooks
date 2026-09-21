import { NextResponse } from "next/server";
import { getMyReviewWorkspace } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";

export const runtime = "nodejs";

/**
 * The caller's own review workspace: owed self-assessments, manager
 * reviews shared with them (calibration stripped), and their own goals.
 * An unshared manager review never appears — the privacy scope lives in
 * the engine read, never in this route.
 */
export async function GET() {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const workspace = await getMyReviewWorkspace({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ workspace });
  } catch (e) {
    return meErrorResponse(e);
  }
}
