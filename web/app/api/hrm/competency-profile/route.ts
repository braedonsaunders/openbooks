import { NextResponse } from "next/server";
import { competencyProfileForEmployment } from "@openbooks/engine/src/hrm/performance/competencies.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";

export const runtime = "nodejs";

/**
 * Expected vs assessed competencies for one employment, from their last
 * calibrated (or shared) manager review. Serves the employee record
 * drawer's Competencies section. Readers without the performance grant
 * get 403 and the section hides. The client checks res.ok before
 * parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmCompetencies"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const employmentId = new URL(req.url).searchParams.get("employmentId");
  if (!employmentId || !isUuid(employmentId)) {
    return NextResponse.json({ error: "employmentId must be a uuid" }, { status: 400 });
  }
  try {
    const profile = await competencyProfileForEmployment({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      employmentId,
    });
    return NextResponse.json({ profile });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
