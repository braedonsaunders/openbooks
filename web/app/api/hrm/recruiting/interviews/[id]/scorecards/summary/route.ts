import { NextResponse } from "next/server";
import { scorecardSummary } from "@openbooks/engine/src/hrm/recruiting/scorecards.ts";
import { guardPermission } from "../../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../../_lib";

export const runtime = "nodejs";

/**
 * Hiring-manager scorecard summary: aggregates over submitted verdicts
 * with missing seats listed by name (manager scope in the service). 404s
 * while hrm, hrmRecruiting, or hrmStructuredInterviews is off.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmStructuredInterviews"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const summary = await scorecardSummary({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      interviewId: id,
    });
    return NextResponse.json({ summary });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
