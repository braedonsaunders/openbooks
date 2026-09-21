import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listFeedback, writeFeedback } from "@openbooks/engine/src/hrm/performance/feedback.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { writeFeedbackBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmFeedback"))
  );
}

/**
 * Feedback. GET lists visibility-filtered rows (narrowed by
 * ?subjectEmploymentId); POST writes praise, feedback, or a request
 * (requests notify the requested party). The client checks res.ok
 * before parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const subjectEmploymentId = new URL(req.url).searchParams.get("subjectEmploymentId");
  if (subjectEmploymentId !== null && !isUuid(subjectEmploymentId)) {
    return NextResponse.json({ error: "subjectEmploymentId must be a uuid" }, { status: 400 });
  }
  try {
    const rows = await listFeedback({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...(subjectEmploymentId ? { subjectEmploymentId } : {}),
    });
    return NextResponse.json({ feedback: rows });
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
  const parsedBody = await parseJsonBody(req, writeFeedbackBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const row = await writeFeedback({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      subjectEmploymentId: body.subjectEmploymentId,
      kind: body.kind,
      visibility: body.visibility,
      body: body.body,
      context: body.context ?? null,
      requestedFromPartyId: body.requestedFromPartyId ?? null,
    });
    return NextResponse.json({ feedback: row }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
