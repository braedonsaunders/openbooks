import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { saveAttendanceDevice } from "@openbooks/engine/schedule-boards/attendance";
import { deviceBody } from "../contract";

/** Rename or (de)activate a device; its code, legal entity and time zone are fixed. */
export const PATCH = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  params: z.object({ id: uuidString() }),
  body: deviceBody.extend({ expectedRevision: z.number().int().positive() }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await saveAttendanceDevice(
        { orgId: authz.user.orgId, actorId: authz.user.id },
        { ...body, id: params.id },
      ),
    ),
});
