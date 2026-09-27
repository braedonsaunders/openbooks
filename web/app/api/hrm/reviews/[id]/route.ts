import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  acknowledgeReview,
  calibrateReview,
  reopenReview,
  shareReview,
  submitReview,
} from "@openbooks/engine/src/hrm/performance/reviews.ts";
import { getReviewDetail } from "@openbooks/engine/src/hrm/performance/performance-read.ts";

import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchReviewBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One review: GET resolves the review with its snapshot answers through
 * the privacy scope (HR, its reviewer, or its subject once shared — anyone
 * else 404s uniformly); PATCH submits, calibrates, shares, acknowledges,
 * or reopens through an action-discriminated body. Authorship is identity
 * in the service (reviewer, subject, or HR with a reason) — the route
 * carries the authenticated caller, never a permission shortcut. The
 * client checks res.ok before parsing: whole-call denials are HTTP errors
 * with `{ error }` bodies.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
      if (!(await isFeatureEnabled(authz.user.orgId, "hrmPerformance"))) {
      return notFound("record");
    }
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid review" }, { status: 400 });
    try {
      const detail = await getReviewDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        reviewId: id,
      });
      return NextResponse.json(detail);
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: patchReviewBody,
  handler: async ({
    request: req,
    authz: authz,
    params: routeParams,
    body: body,
  }) => {
      if (!(await isFeatureEnabled(authz.user.orgId, "hrmPerformance"))) {
      return notFound("record");
    }
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid review" }, { status: 400 });

    const base = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      reviewId: id,
    };
    try {
      if (body.action === "submit") {
        const review = await submitReview({
          ...base,
          answers: body.answers,
          overallRating: body.overallRating ?? null,
        });
        return NextResponse.json({ review });
      }
      if (body.action === "calibrate") {
        const review = await calibrateReview({
          ...base,
          calibratedRating: body.calibratedRating,
          reason: body.reason,
        });
        return NextResponse.json({ review });
      }
      if (body.action === "share") {
        const review = await shareReview(base);
        return NextResponse.json({ review });
      }
      if (body.action === "acknowledge") {
        const review = await acknowledgeReview(base);
        return NextResponse.json({ review });
      }
      const review = await reopenReview({ ...base, reason: body.reason });
      return NextResponse.json({ review });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
