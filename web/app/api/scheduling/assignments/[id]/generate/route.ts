import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { generateAssignment } from "@openbooks/engine/schedule-boards/pattern-store";

/** Generate an assignment's bookings through a date, or through its pattern's horizon. */
export const POST = defineRoute({
  permission: "hrm.shifts.manage",
  feature: "hrmShiftPlanning",
  params: z.object({ id: uuidString() }),
  body: z.strictObject({
    through: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    reason: z.string().max(2000).nullable().optional(),
  }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await generateAssignment({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        assignmentId: params.id,
        through: body.through ?? null,
        reason: body.reason ?? null,
      }),
    ),
});
