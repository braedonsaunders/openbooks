import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { acknowledgeMyReview } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../../_lib";
import { acknowledgeReviewBody } from "../../bodies";
/**
 * Acknowledge a review shared with the caller. The body names the review;
 * the engine proves the caller is its subject — another person's id is
 * refused by identity, never acknowledged.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: acknowledgeReviewBody,
  invalidBodyStatus: 400,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const review = await acknowledgeMyReview({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        reviewId: body.reviewId,
      });
      return NextResponse.json({
        review: { id: review.id, status: review.status },
      });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
