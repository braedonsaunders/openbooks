import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  fulfillRequest,
  listOpenRequestsForParty,
} from "@openbooks/engine/src/hrm/performance/feedback.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { fulfillRequestBody } from "./bodies";

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
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  void req;
  try {
    const requests = await listOpenRequestsForParty({ orgId: authz.user.orgId, actorId: authz.user.id });
    return NextResponse.json({ requests });
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
  const parsedBody = await parseJsonBody(req, fulfillRequestBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
