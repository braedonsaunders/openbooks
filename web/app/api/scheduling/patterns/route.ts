import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { savePattern } from "@openbooks/engine/schedule-boards/pattern-store";
import { patternBody, patternInput } from "./contract";

/** Create a recurring shift pattern from Setup → Shift patterns. */
export const POST = defineRoute({
  permission: "hrm.shifts.manage",
  feature: "hrmShiftPlanning",
  body: patternBody,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await savePattern({ orgId: authz.user.orgId, actorId: authz.user.id }, patternInput(body)),
    ),
});
