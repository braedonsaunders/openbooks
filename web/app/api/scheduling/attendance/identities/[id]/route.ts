import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { saveAttendanceIdentity } from "@openbooks/engine/schedule-boards/attendance";
import { identityBody } from "../contract";

/** End a device mapping; every other fact of the mapping is fixed. */
export const PATCH = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  params: z.object({ id: uuidString() }),
  body: identityBody.extend({ expectedRevision: z.number().int().positive() }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await saveAttendanceIdentity(
        { orgId: authz.user.orgId, actorId: authz.user.id },
        { ...body, id: params.id },
      ),
    ),
});
