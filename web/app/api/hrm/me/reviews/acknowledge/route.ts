import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { acknowledgeMyReview } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { meErrorResponse } from "../../_lib";
import { acknowledgeReviewBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Acknowledge a review shared with the caller. The body names the review;
 * the engine proves the caller is its subject — another person's id is
 * refused by identity, never acknowledged.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, acknowledgeReviewBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const review = await acknowledgeMyReview({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      reviewId: body.reviewId,
    });
    return NextResponse.json({ review: { id: review.id, status: review.status } });
  } catch (e) {
    return meErrorResponse(e);
  }
}
