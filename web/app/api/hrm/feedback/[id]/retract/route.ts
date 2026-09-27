import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { retractFeedback } from "@openbooks/engine/src/hrm/performance/feedback.ts";

import { isFeatureEnabled } from "../../../../../../lib/features";
import { performanceErrorResponse } from "../../../review-cycles/_lib";

export const runtime = "nodejs";

/**
 * Retract feedback: author or HR records a retraction row linking the
 * original (append-only — the row is never updated or deleted). The
 * client checks res.ok before parsing.
 */
export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
    if (
      !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmFeedback"))
    ) {
      return notFound("record");
    }
    const { id } = routeParams;
    try {
      await retractFeedback({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        id,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
