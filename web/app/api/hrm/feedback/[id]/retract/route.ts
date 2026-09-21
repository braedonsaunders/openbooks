import { NextResponse } from "next/server";
import { retractFeedback } from "@openbooks/engine/src/hrm/performance/feedback.ts";
import { getAuthz } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";

export const runtime = "nodejs";

/**
 * Retract feedback: author or HR records a retraction row linking the
 * original (append-only — the row is never updated or deleted). The
 * client checks res.ok before parsing.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmFeedback"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  try {
    await retractFeedback({ orgId: authz.user.orgId, actorId: authz.user.id, id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
