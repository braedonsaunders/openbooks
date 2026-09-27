import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  revertEntry,
  setCalibratedRating,
  setPotential,
} from "@openbooks/engine/src/hrm/performance/calibration.ts";

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
export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: patchCalibrationEntryBody,
  handler: async ({
    authz: authz,
    params: routeParams,
    body: body,
  }) => {
    if (
      !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance"))
    ) {
      return notFound("record");
    }

    const { id } = routeParams;
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
        await setPotential({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          entryId: id,
          potentialKey: body.potentialKey,
        });
        return NextResponse.json({ ok: true });
      }
      await revertEntry({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        entryId: id,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
