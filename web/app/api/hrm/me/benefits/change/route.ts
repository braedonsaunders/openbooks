import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { changeMyBenefit } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../../_lib";
import { changeBenefitBody } from "../../bodies";
/**
 * Change an active election from a date inside an open window covering
 * the caller's employment. The body names the enrollment; the engine
 * proves it sits on the caller's own employment and the change date
 * sits inside an open window — both refusals name the remedy.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: changeBenefitBody,
  invalidBodyStatus: 400,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const enrollment = await changeMyBenefit({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        enrollmentId: body.enrollmentId,
        changeDate: body.changeDate,
        classKey: body.classKey,
        matchEligible: body.matchEligible,
        contributionTerms: body.contributionTerms,
        reason: body.reason,
      });
      return NextResponse.json({ enrollment });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
