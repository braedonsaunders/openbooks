import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { submitLeaveRequest } from "@openbooks/engine/src/hrm/leave.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { leaveErrorResponse } from "../../_lib";
import { submitLeaveRequestBody } from "../../bodies";

export const runtime = "nodejs";

/** Submit a draft for governed approval (opens the approval run). */
export const POST = defineRoute({
  permission: "hrm.leave.request",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: submitLeaveRequestBody,
  handler: async ({
    authz: gate,
    params: routeParams,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );

    try {
      const request = await submitLeaveRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return leaveErrorResponse(e);
    }
  },
});
