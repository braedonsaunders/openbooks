import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getFeedbackSettings,
  setFeedbackSettings,
} from "@openbooks/engine/src/hrm/performance/feedback.ts";
import { getAuthz } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";

export const runtime = "nodejs";

const settingsBody = z.object({ publicPraiseBy: z.enum(["anyone", "managers_and_hr"]) });

/**
 * Feedback settings (who may praise publicly). HR-only reads and
 * writes; the write service enforces the setting, never the UI alone.
 * The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmFeedback"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  void req;
  try {
    const settings = await getFeedbackSettings({ orgId: authz.user.orgId, actorId: authz.user.id });
    return NextResponse.json({ settings });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmFeedback"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, settingsBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const settings = await setFeedbackSettings({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      publicPraiseBy: parsedBody.data.publicPraiseBy,
    });
    return NextResponse.json({ settings });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
