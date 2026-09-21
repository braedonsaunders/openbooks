import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  calibrationDistribution,
  closeCalibrationSession,
  getCalibrationSession,
  openCalibrationSession,
} from "@openbooks/engine/src/hrm/performance/calibration.ts";
import { getAuthz } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchCalibrationSessionBody } from "../bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmCalibration"))
  );
}

/**
 * One calibration session: the grid (entries plus the missing list
 * with reasons), the distribution strip (?view=distribution), and
 * open/close transitions. HR-only. The client checks res.ok before
 * parsing.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  try {
    if (new URL(req.url).searchParams.get("view") === "distribution") {
      const distribution = await calibrationDistribution({ orgId: authz.user.orgId, actorId: authz.user.id, id });
      return NextResponse.json({ distribution });
    }
    const session = await getCalibrationSession({ orgId: authz.user.orgId, actorId: authz.user.id, id });
    return NextResponse.json({ session });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, patchCalibrationSessionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const { id } = await ctx.params;
  try {
    const session =
      parsedBody.data.action === "open"
        ? await openCalibrationSession({ orgId: authz.user.orgId, actorId: authz.user.id, id })
        : await closeCalibrationSession({ orgId: authz.user.orgId, actorId: authz.user.id, id });
    return NextResponse.json({ session });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
