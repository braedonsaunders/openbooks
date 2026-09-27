import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { submitMySelfAssessment } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../../_lib";
import { submitSelfAssessmentBody } from "../../bodies";
/**
 * Submit the caller's own self-assessment with its answers. The engine
 * proves the caller is the review's reviewer — another reviewer's id is
 * refused by identity. Answering in full rides the performance drawer;
 * this route is the API twin with the same evidence rules.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: submitSelfAssessmentBody,
  handler: async ({ request: req, authz: gate, body }) => {
    try {
      const review = await submitMySelfAssessment({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        reviewId: body.reviewId,
        answers: body.answers,
        overallRating: body.overallRating,
      });
      return NextResponse.json({
        review: { id: review.id, status: review.status },
      });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
