import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { recordAbsence } from "@openbooks/engine/src/hrm/attendance.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { leaveErrorResponse } from "../leave-requests/_lib";
import { recordAbsenceBody } from "../leave-requests/bodies";

export const runtime = "nodejs";

/**
 * Record an absence after the fact (manager-held). Writes the absence
 * record only — never a pay-run input and never a time entry: value
 * treatment for a backdated day goes through a leave request or a retro run.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.leave.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, recordAbsenceBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const absence = await recordAbsence({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      onDate: body.onDate,
      hours: body.hours,
      leaveTypeId: body.leaveTypeId,
    });
    return NextResponse.json({ absence });
  } catch (e) {
    return leaveErrorResponse(e);
  }
}
