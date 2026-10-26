import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { deviceBody } from "./contract";
import {
  listAttendanceDevices,
  saveAttendanceDevice,
} from "@openbooks/engine/schedule-boards/attendance";

/** Active devices whose check-ins the caller may import. */
export const GET = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  handler: async ({ authz }) =>
    NextResponse.json({
      devices: await listAttendanceDevices({ orgId: authz.user.orgId, actorId: authz.user.id }),
    }),
});

/** Register a time-clock device from Setup → Attendance devices. */
export const POST = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  body: deviceBody,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await saveAttendanceDevice({ orgId: authz.user.orgId, actorId: authz.user.id }, body),
    ),
});
