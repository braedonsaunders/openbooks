import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  cancelInterview,
  completeInterview,
} from "@openbooks/engine/src/hrm/recruiting/interviews.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchInterviewBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One interview: PATCH completes a sitting with its verdict or cancels a
 * scheduled one — through an action-discriminated body. Completed sittings
 * stand as recorded.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid interview" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchInterviewBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "complete") {
      const interview = await completeInterview({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
        outcome: body.outcome,
        feedback: body.feedback,
        scorecard: body.scorecard,
      });
      return NextResponse.json({ interview });
    }
    const interview = await cancelInterview({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      interviewId: id,
    });
    return NextResponse.json({ interview });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
