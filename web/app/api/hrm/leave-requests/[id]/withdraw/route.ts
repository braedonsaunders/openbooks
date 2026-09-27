import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withdrawLeaveRequest } from "@openbooks/engine/src/hrm/leave.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { leaveErrorResponse } from "../../_lib";
import { leaveDecisionBody } from "../../bodies";

export const runtime = "nodejs";

/** Withdraw a draft or a submitted request, with a reason. */
export const POST = defineRoute({
  permission: "hrm.leave.request",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: leaveDecisionBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );

    try {
      const request = await withdrawLeaveRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        reason: body.reason,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return leaveErrorResponse(e);
    }
  },
});
