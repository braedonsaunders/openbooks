import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  fulfillRequest,
  listOpenRequestsForParty,
} from "@openbooks/engine/src/hrm/performance/feedback.ts";

import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { fulfillRequestBody } from "../bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmFeedback"))
  );
}

/**
 * Feedback requests addressed to the caller. GET lists the open ones
 * (the hrm_feedback_request inbox adapter reads through the same
 * service call); POST fulfils one by writing the answering feedback.
 * The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ authz: authz }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    void req;
    try {
      const requests = await listOpenRequestsForParty({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ requests });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: fulfillRequestBody,
  handler: async ({ authz: authz, body: body }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    try {
      const row = await fulfillRequest({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        requestId: body.requestId,
        visibility: body.visibility,
        body: body.body,
      });
      return NextResponse.json({ feedback: row }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
