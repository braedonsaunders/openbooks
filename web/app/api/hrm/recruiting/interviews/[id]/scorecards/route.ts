import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { readScorecardsForInterview, submitScorecard } from "@openbooks/engine/src/hrm/recruiting/scorecards.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { submitScorecardBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interview scorecards: GET reads under the blind rule (own card plus
 * others only after submitting, unless privileged), POST submits the
 * actor's own verdict. The read gate is hrm.recruiting.read; submitting
 * needs a panel seat (checked in the service). 404s while hrm,
 * hrmRecruiting, or hrmStructuredInterviews is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmStructuredInterviews");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const cards = await readScorecardsForInterview({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      interviewId: id,
    });
    return NextResponse.json(cards);
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, submitScorecardBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const card = await submitScorecard({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      interviewId: id,
      overall: body.overall,
      ratings: body.ratings,
      privateNotes: body.privateNotes,
      sharedNotes: body.sharedNotes,
    });
    return NextResponse.json({ scorecard: card }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
