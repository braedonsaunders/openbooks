import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { submitMySelfAssessment } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { meErrorResponse } from "../../_lib";
import { submitSelfAssessmentBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Submit the caller's own self-assessment with its answers. The engine
 * proves the caller is the review's reviewer — another reviewer's id is
 * refused by identity. Answering in full rides the performance drawer;
 * this route is the API twin with the same evidence rules.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, submitSelfAssessmentBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const review = await submitMySelfAssessment({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      reviewId: body.reviewId,
      answers: body.answers,
      overallRating: body.overallRating,
    });
    return NextResponse.json({ review: { id: review.id, status: review.status } });
  } catch (e) {
    return meErrorResponse(e);
  }
}
