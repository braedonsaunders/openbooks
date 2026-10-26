import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { closeAssignment } from "@openbooks/engine/schedule-boards/pattern-store";

/** End an assignment from a date, or cancel it; its future generated bookings are removed. */
export const PATCH = defineRoute({
  permission: "hrm.shifts.manage",
  feature: "hrmShiftPlanning",
  params: z.object({ id: uuidString() }),
  body: z.strictObject({
    action: z.enum(["end", "cancel"]),
    expectedRevision: z.number().int().positive(),
    effectiveTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    reason: z.string().trim().min(1).max(2000),
  }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await closeAssignment({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        assignmentId: params.id,
        ...body,
      }),
    ),
});
