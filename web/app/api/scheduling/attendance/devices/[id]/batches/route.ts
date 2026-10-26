import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  admitAttendanceBatch,
  processBatchAttendance,
} from "@openbooks/engine/schedule-boards/attendance";

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/**
 * Admit a batch of device check-ins with the device's declared completeness,
 * then observe attendance for the shifts of the people it names. The same
 * batch key and content replay the original batch.
 */
export const POST = defineRoute({
  permission: "hrm.attendance.manage",
  feature: "hrmAttendance",
  params: z.object({ id: uuidString() }),
  body: z.strictObject({
    id: uuidString(),
    completeThrough: instant.nullable(),
    correction: z.boolean().optional(),
    sourceEvidence: z
      .record(z.string(), z.json())
      .refine(
        (value) => typeof value.source === "string" && value.source.trim().length > 0,
        "Name the source connection or import file",
      ),
    reason: z.string().trim().min(1).max(2000),
    events: z
      .array(
        z.strictObject({
          id: uuidString(),
          sourceEventId: z.string().trim().min(1).max(160),
          sourceVersion: z.number().int().positive(),
          sourceWorkerId: z.string().trim().min(1).max(160),
          kind: z.enum(["clock_in", "clock_out", "break_start", "break_end", "void"]),
          occurredAt: instant,
          sourcePayload: z.record(z.string(), z.json()),
          supersedesId: uuidString().nullable(),
        }),
      )
      .max(10000),
  }),
  handler: async ({ authz, params, body }) => {
    const actor = { orgId: authz.user.orgId, actorId: authz.user.id };
    const batch = await admitAttendanceBatch({ ...actor, ...body, deviceId: params.id });
    // Attendance follows the committed batch; a refusal there never undoes the admitted check-ins.
    const outcomes = await processBatchAttendance({ ...actor, batch });
    return NextResponse.json({ batch, outcomes });
  },
});
