import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { scheduleInterview } from "@openbooks/engine/src/hrm/recruiting/interviews.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { scheduleInterviewBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interviews collection: POST schedules a sitting on an active application
 * (manage gate in the service). Every panel member must be an employee the
 * scheduler can see — a panel of strangers refuses by name.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, scheduleInterviewBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const interview = await scheduleInterview({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      applicationId: body.applicationId,
      kind: body.kind,
      scheduledAt: body.scheduledAt,
      durationMinutes: body.durationMinutes,
      location: body.location,
      panelPartyIds: body.panelPartyIds,
      // HR-18: optional kit + focus pins ride the same call.
      kitId: body.kitId,
      panelFocus: body.panelFocus,
    });
    return NextResponse.json({ interview }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
