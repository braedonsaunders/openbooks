import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { addAttendancePolicy } from "@openbooks/engine/schedule-boards/attendance";

const minutes = z.number().int().min(0).max(720);

/** Add a board attendance policy version effective from a date. */
export const POST = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  body: z.strictObject({
    boardId: uuidString(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    captureBeforeMinutes: minutes,
    captureAfterMinutes: minutes,
    lateGraceMinutes: minutes,
    earlyGraceMinutes: minutes,
    breakGraceMinutes: minutes,
    reason: z.string().trim().min(1).max(2000),
  }),
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await addAttendancePolicy({ orgId: authz.user.orgId, actorId: authz.user.id }, body),
    ),
});
