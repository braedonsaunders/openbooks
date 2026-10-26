import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { revokePatternException } from "@openbooks/engine/schedule-boards/pattern-store";

/** Revoke an occurrence exception; the occurrence is generated again. */
export const POST = defineRoute({
  permission: "hrm.shifts.manage",
  feature: "hrmShiftPlanning",
  params: z.object({ id: uuidString() }),
  body: z.strictObject({ reason: z.string().trim().min(1).max(2000) }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await revokePatternException({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        exceptionId: params.id,
        reason: body.reason,
      }),
    ),
});
