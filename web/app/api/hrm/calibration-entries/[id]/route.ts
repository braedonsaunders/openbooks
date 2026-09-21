import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  revertEntry,
  setCalibratedRating,
  setPotential,
} from "@openbooks/engine/src/hrm/performance/calibration.ts";
import { getAuthz } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchCalibrationEntryBody } from "../../calibration-sessions/bodies";

export const runtime = "nodejs";

/**
 * One calibration grid entry: change the rating with justification,
 * set potential, or revert. Refused after close, and refused when the
 * decider authored the review. HR-only. The client checks res.ok
 * before parsing.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmCalibration"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, patchCalibrationEntryBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const { id } = await ctx.params;
  try {
    if (body.action === "rate") {
      const entry = await setCalibratedRating({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        entryId: id,
        calibratedRating: body.calibratedRating,
        justification: body.justification,
      });
      return NextResponse.json({ entry });
    }
    if (body.action === "potential") {
      await setPotential({ orgId: authz.user.orgId, actorId: authz.user.id, entryId: id, potentialKey: body.potentialKey });
      return NextResponse.json({ ok: true });
    }
    await revertEntry({ orgId: authz.user.orgId, actorId: authz.user.id, entryId: id, reason: body.reason });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
