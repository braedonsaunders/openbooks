import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createCalibrationSession,
  listCalibrationSessions,
} from "@openbooks/engine/src/hrm/performance/calibration.ts";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createCalibrationSessionBody } from "./bodies";
/**
 * Calibration sessions. GET lists (narrowed by ?cycleId); POST creates
 * a draft over a cycle. HR-only. The client checks res.ok before
 * parsing.
 */
export const GET = defineRoute({
  permission: "hrm.performance.read",
  feature: "hrmPerformance",
  handler: async ({ request: req, authz }) => {
    const cycleId = new URL(req.url).searchParams.get("cycleId");
    if (cycleId !== null && !isUuid(cycleId)) {
      return NextResponse.json(
        { error: "cycleId must be a uuid" },
        { status: 400 },
      );
    }
    try {
      const sessions = await listCalibrationSessions({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(cycleId ? { cycleId } : {}),
      });
      return NextResponse.json({ sessions });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmPerformance",
  body: createCalibrationSessionBody,
  handler: async ({ request: _req, authz, body }) => {
    try {
      const session = await createCalibrationSession({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        cycleId: body.cycleId,
        name: body.name,
        scope: body.scope ?? null,
        facilitatorPartyId: body.facilitatorPartyId ?? null,
      });
      return NextResponse.json({ session }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
