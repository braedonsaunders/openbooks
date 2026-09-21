import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  listTalentReviews,
  nineBoxForCycle,
  recordTalentReview,
} from "@openbooks/engine/src/hrm/performance/talent.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { recordTalentReviewBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmSuccession"))
  );
}

/**
 * Talent reviews. GET lists HR-only rows (narrowed by ?cycleId) or
 * reads the 9-box (?view=ninebox&cycleId=…); POST records the manager
 * questionnaire. The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  const cycleId = params.get("cycleId");
  if (cycleId !== null && !isUuid(cycleId)) {
    return NextResponse.json({ error: "cycleId must be a uuid" }, { status: 400 });
  }
  try {
    if (params.get("view") === "ninebox") {
      if (!cycleId) return NextResponse.json({ error: "cycleId is required for the 9-box" }, { status: 400 });
      const nineBox = await nineBoxForCycle({ orgId: authz.user.orgId, actorId: authz.user.id, cycleId });
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
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, recordTalentReviewBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const review = await recordTalentReview({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      employmentId: body.employmentId,
      cycleId: body.cycleId ?? null,
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
}
