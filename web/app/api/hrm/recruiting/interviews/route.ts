import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { scheduleInterview } from "@openbooks/engine/src/hrm/recruiting/interviews.ts";

import { recruitingErrorResponse } from "../_lib";
import { scheduleInterviewBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interviews collection: POST schedules a sitting on an active application
 * (manage gate in the service). Every panel member must be an employee the
 * scheduler can see — a panel of strangers refuses by name.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: scheduleInterviewBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
    try {
      const interview = await scheduleInterview({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        applicationId: body.applicationId,
        kind: body.kind,
        scheduledAt: body.scheduledAt,
        durationMinutes: body.durationMinutes,
        location: body.location,
        panelPartyIds: body.panelPartyIds,
        // Optional kit + focus pins ride the same call.
        kitId: body.kitId,
        panelFocus: body.panelFocus,
      });
      return NextResponse.json({ interview }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
