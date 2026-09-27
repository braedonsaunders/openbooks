import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fulfilPayInformationRequest,
  refusePayInformationRequest,
} from "@openbooks/engine/src/hrm/compensation/pay-transparency.ts";

import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";

export const runtime = "nodejs";

/**
 * One pay-information request: PUT {action: fulfil} answers from the
 * latest snapshot covering the worker's category (refusing when none
 * does); PUT {action: refuse} refuses with a reason the worker reads.
 * Both ride comp.manage. The client checks res.ok before parsing.
 */
export const PUT = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmPayTransparency",
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    action: z.enum(["fulfil", "refuse"]),
    reason: z.string().trim().min(1).max(2000).nullable().optional(),
  }),
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid request" }, { status: 400 });

    try {
      if (body.action === "fulfil") {
        const request = await fulfilPayInformationRequest({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          requestId: id,
        });
        return NextResponse.json({ request });
      }
      if (!body.reason)
        return NextResponse.json({ error: "reason required" }, { status: 400 });
      const request = await refusePayInformationRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        reason: body.reason,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
