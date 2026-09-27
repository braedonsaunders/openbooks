import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  closeCycle,
  moveToCalibrating,
  openCycle,
} from "@openbooks/engine/src/hrm/performance/review-cycles.ts";
import { getCycleDetail } from "@openbooks/engine/src/hrm/performance/performance-read.ts";

import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { performanceErrorResponse } from "../_lib";
import { patchCycleBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One review cycle: GET resolves the cycle with its readable reviews and
 * progress (privacy scope in the service — an unreadable id 404s
 * uniformly); PATCH opens, moves to calibrating, or closes through an
 * action-discriminated body (performance manage gate in the service). The
 * client checks res.ok before parsing: whole-call denials are HTTP errors
 * with `{ error }` bodies.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
      if (!(await isFeatureEnabled(authz.user.orgId, "hrmPerformance"))) {
      return notFound("record");
    }
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid review cycle" },
        { status: 400 },
      );
    try {
      const cycle = await getCycleDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        cycleId: id,
      });
      return NextResponse.json({ cycle });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmPerformance",
  params: z.object({ id: z.string().min(1) }),
  body: patchCycleBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid review cycle" },
        { status: 400 },
      );

    try {
      if (body.action === "open") {
        const opened = await openCycle({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          cycleId: id,
        });
        return NextResponse.json(opened);
      }
      if (body.action === "to-calibrating") {
        const cycle = await moveToCalibrating({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          cycleId: id,
          force: body.force ?? false,
          forceReason: body.forceReason,
        });
        return NextResponse.json({ cycle });
      }
      const cycle = await closeCycle({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        cycleId: id,
      });
      return NextResponse.json({ cycle });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
