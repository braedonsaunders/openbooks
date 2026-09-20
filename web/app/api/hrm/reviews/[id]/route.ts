import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  acknowledgeReview,
  calibrateReview,
  reopenReview,
  shareReview,
  submitReview,
} from "@openbooks/engine/src/hrm/performance/reviews.ts";
import { getReviewDetail } from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { getAuthz } from "../../../../../lib/authz";
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
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid review" }, { status: 400 });
  try {
    const detail = await getReviewDetail({ orgId: authz.user.orgId, actorId: authz.user.id, reviewId: id });
    return NextResponse.json(detail);
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid review" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchReviewBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const base = { orgId: authz.user.orgId, actorId: authz.user.id, reviewId: id };
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
      const review = await calibrateReview({ ...base, calibratedRating: body.calibratedRating, reason: body.reason });
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
}
