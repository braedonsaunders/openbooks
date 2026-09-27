import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  calibrationDistribution,
  closeCalibrationSession,
  getCalibrationSession,
  openCalibrationSession,
} from "@openbooks/engine/src/hrm/performance/calibration.ts";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchCalibrationSessionBody } from "../bodies";
/**
 * One calibration session: the grid (entries plus the missing list
 * with reasons), the distribution strip (?view=distribution), and
 * open/close transitions. HR-only. The client checks res.ok before
 * parsing.
 */
export const GET = defineRoute({
  permission: "hrm.performance.read",
  feature: "hrmPerformance",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz, params }) => {
    const { id } = params;
    try {
      if (new URL(req.url).searchParams.get("view") === "distribution") {
        const distribution = await calibrationDistribution({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id,
        });
        return NextResponse.json({ distribution });
      }
      const session = await getCalibrationSession({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        id,
      });
      return NextResponse.json({ session });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
export const PATCH = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmPerformance",
  body: patchCalibrationSessionBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz, params, body }) => {
    const { id } = params;
    try {
      const session =
        body.action === "open"
          ? await openCalibrationSession({
              orgId: authz.user.orgId,
              actorId: authz.user.id,
              id,
            })
          : await closeCalibrationSession({
              orgId: authz.user.orgId,
              actorId: authz.user.id,
              id,
            });
      return NextResponse.json({ session });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
