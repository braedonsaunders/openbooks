import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { cancelLeaveRequest } from "@openbooks/engine/src/hrm/leave.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { leaveErrorResponse } from "../../_lib";
import { leaveDecisionBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Cancel an approved request, with a reason: reverses absences and voids
 * pending inputs. Cancelling a request a committed run already consumed is
 * refused with the retro remedy — a paid row is never flipped to voided.
 */
export const POST = defineRoute({
  permission: "hrm.leave.request",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: leaveDecisionBody,
  invalidBodyStatus: 400,
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
      const request = await cancelLeaveRequest({
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
