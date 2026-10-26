import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { savePattern } from "@openbooks/engine/schedule-boards/pattern-store";
import { patternBody, patternInput } from "../contract";

/** Revise a pattern; only bookings generated afterwards follow the revision. */
export const PATCH = defineRoute({
  permission: "hrm.shifts.manage",
  feature: "hrmShiftPlanning",
  params: z.object({ id: uuidString() }),
  body: patternBody.extend({ expectedRevision: z.number().int().positive() }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await savePattern(
        { orgId: authz.user.orgId, actorId: authz.user.id },
        { ...patternInput(body), id: params.id, expectedRevision: body.expectedRevision },
      ),
    ),
});
