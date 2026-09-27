import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  listTalentReviews,
  nineBoxForCycle,
  recordTalentReview,
} from "@openbooks/engine/src/hrm/performance/talent.ts";

import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { recordTalentReviewBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance"))
  );
}

/**
 * Talent reviews. GET lists HR-only rows (narrowed by ?cycleId) or
 * reads the 9-box (?view=ninebox&cycleId=…); POST records the manager
 * questionnaire. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: authz }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const params = new URL(req.url).searchParams;
    const cycleId = params.get("cycleId");
    if (cycleId !== null && !isUuid(cycleId)) {
      return NextResponse.json(
        { error: "cycleId must be a uuid" },
        { status: 400 },
      );
    }
    try {
      if (params.get("view") === "ninebox") {
        if (!cycleId)
          return NextResponse.json(
            { error: "cycleId is required for the 9-box" },
            { status: 400 },
          );
        const nineBox = await nineBoxForCycle({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          cycleId,
        });
        return NextResponse.json({ nineBox });
      }
      const reviews = await listTalentReviews({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(cycleId ? { cycleId } : {}),
      });
      return NextResponse.json({ talentReviews: reviews });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: recordTalentReviewBody,
  handler: async ({ authz: authz, body: body }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    try {
      const review = await recordTalentReview({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId: body.employmentId,
        cycleId: body.cycleId,
        performanceKey: body.performanceKey,
        potentialKey: body.potentialKey,
        impactOfLoss: body.impactOfLoss,
        riskOfLoss: body.riskOfLoss,
        promotionReady: body.promotionReady ?? false,
        notes: body.notes ?? null,
      });
      return NextResponse.json({ talentReview: review }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
