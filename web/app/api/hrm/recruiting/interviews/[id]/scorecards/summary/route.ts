import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { scorecardSummary } from "@openbooks/engine/src/hrm/recruiting/scorecards.ts";

import { recruitingErrorResponse } from "../../../../_lib";

export const runtime = "nodejs";

/**
 * Hiring-manager scorecard summary: aggregates over submitted verdicts
 * with missing seats listed by name (manager scope in the service). 404s
 * while hrm, hrmRecruiting, or hrmStructuredInterviews is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmStructuredInterviews",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const summary = await scorecardSummary({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
      });
      return NextResponse.json({ summary });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
