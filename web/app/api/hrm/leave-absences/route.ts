import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { recordAbsence } from "@openbooks/engine/src/hrm/attendance.ts";
import { leaveErrorResponse } from "../leave-requests/_lib";
import { recordAbsenceBody } from "../leave-requests/bodies";
/**
 * Record an absence after the fact (manager-held). Writes the absence
 * record only — never a pay-run input and never a time entry: value
 * treatment for a backdated day goes through a leave request or a retro run.
 */
export const POST = defineRoute({
  permission: "hrm.leave.manage",
  feature: "hrm",
  body: recordAbsenceBody,
  handler: async ({ request: req, authz: gate, body }) => {
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
  },
});
