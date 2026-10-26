import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { identityBody } from "./contract";
import { saveAttendanceIdentity } from "@openbooks/engine/schedule-boards/attendance";

/** Map a device's worker identifier to a person from a date. */
export const POST = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  body: identityBody,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await saveAttendanceIdentity({ orgId: authz.user.orgId, actorId: authz.user.id }, body),
    ),
});
