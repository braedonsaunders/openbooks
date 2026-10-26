import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { createCycle } from "@openbooks/engine/hrm/performance/review-cycles";
import { listCycleProgress } from "@openbooks/engine/hrm/performance/performance-read";

import { performanceErrorResponse } from "./_lib";
import { createCycleBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Review cycles. GET lists with progress: HR readers (hrm.performance.read)
 * see every cycle with org-wide counts; a manager with reports and no grant
 * sees only the cycles they participate in, with counts over that slice
 * (the read service narrows every row to the actor's privacy scope). POST
 * opens a draft cycle (performance manage gate in the service).
 */
export const GET = defineRoute({
  public: "session",
  feature: "hrmPerformance",
  handler: async ({ authz: authz }) => {
    try {
      // One loader for both audiences: HR sees every cycle with org-wide
      // counts, structural viewers see their slice (scoped counts) — the
      // read service narrows every row to the actor's privacy scope.
      const cycles = await listCycleProgress({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ cycles });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmPerformance",
  body: createCycleBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const cycle = await createCycle({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        templateId: body.templateId,
        name: body.name,
        periodStartOn: body.periodStartOn,
        periodEndOn: body.periodEndOn,
        selfDueOn: body.selfDueOn ?? null,
        managerDueOn: body.managerDueOn ?? null,
        appliesTo: body.appliesTo ?? {},
        requireManagerReviews: body.requireManagerReviews,
      });
      return NextResponse.json({ cycle }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
