import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listInterviewSlots,
  proposeSlots,
} from "@openbooks/engine/src/hrm/recruiting/scheduling.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { proposeSlotsBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interview slots: GET lists the interview's slots, POST proposes a batch
 * from declared availability windows and mints the candidate self-booking
 * link (manage gate in the service). 404s while hrm, hrmRecruiting, or
 * hrmInterviewScheduling is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmInterviewScheduling",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const slots = await listInterviewSlots({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
      });
      return NextResponse.json({ slots });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmInterviewScheduling",
  params: z.object({ id: z.string().min(1) }),
  body: proposeSlotsBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const result = await proposeSlots({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
        windows: body.windows,
        poolId: body.poolId,
        expiresAt: body.expiresAt,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
