import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getFeedbackSettings,
  setFeedbackSettings,
} from "@openbooks/engine/src/hrm/performance/feedback.ts";
import { guardUnrestrictedScope } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";

export const runtime = "nodejs";

const settingsBody = z.object({
  publicPraiseBy: z.enum(["anyone", "managers_and_hr"]),
});

/**
 * Feedback settings (who may praise publicly). HR-only reads and
 * writes; the write service enforces the setting, never the UI alone.
 * The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ authz: authz }) => {
    const scopeDenied = guardUnrestrictedScope(authz);
    if (scopeDenied) return scopeDenied;
    if (
      !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmFeedback"))
    ) {
      return notFound("record");
    }
    void req;
    try {
      const settings = await getFeedbackSettings({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ settings });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: settingsBody,
  handler: async ({ authz: authz, body: body }) => {
    const scopeDenied = guardUnrestrictedScope(authz);
    if (scopeDenied) return scopeDenied;
    if (
      !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmFeedback"))
    ) {
      return notFound("record");
    }

    try {
      const settings = await setFeedbackSettings({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        publicPraiseBy: body.publicPraiseBy,
      });
      return NextResponse.json({ settings });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
