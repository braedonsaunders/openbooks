import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  getExitRecord,
  updateExitRecord,
} from "@openbooks/engine/src/hrm/performance/exits.ts";

import { isUuid } from "../../../../../lib/list-params";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchExitBody } from "../../exit-records/bodies";

export const runtime = "nodejs";

/**
 * One exit record: GET through the retention read gate (HR only); PATCH
 * corrects it (performance manage gate in the service). Deletes are
 * refused by trigger — corrections update the one row per employment. The
 * client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.retention.read",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid exit record" },
        { status: 400 },
      );
    try {
      const exit = await getExitRecord({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        exitId: id,
      });
      return NextResponse.json({ exit });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: patchExitBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid exit record" },
        { status: 400 },
      );

    try {
      const exit = await updateExitRecord({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        exitId: id,
        expectedRevision: body.expectedRevision,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.reasonKind ? { reasonKind: body.reasonKind } : {}),
        ...(body.isVoluntary !== undefined
          ? { isVoluntary: body.isVoluntary }
          : {}),
        ...(body.isRegrettable !== undefined
          ? { isRegrettable: body.isRegrettable }
          : {}),
        ...(body.wouldRehire !== undefined
          ? { wouldRehire: body.wouldRehire }
          : {}),
        ...(body.interviewHeldOn !== undefined
          ? { interviewHeldOn: body.interviewHeldOn }
          : {}),
        ...(body.interviewerPartyId !== undefined
          ? { interviewerPartyId: body.interviewerPartyId }
          : {}),
        ...(body.destination !== undefined
          ? { destination: body.destination }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      });
      return NextResponse.json({ exit });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
