import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { competencyProfileForEmployment } from "@openbooks/engine/src/hrm/performance/competencies.ts";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
/**
 * Expected vs assessed competencies for one employment, from their last
 * calibrated (or shared) manager review. Serves the employee record
 * drawer's Competencies section. HR readers see employments inside
 * their allowed subsidiaries, the subject and their line manager see
 * their own slice; anyone else gets 403 and the section hides. The
 * client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  feature: "hrmPerformance",
  handler: async ({ request: req, authz }) => {
    const employmentId = new URL(req.url).searchParams.get("employmentId");
    if (!employmentId || !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employmentId must be a uuid" },
        { status: 400 },
      );
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
  },
});
