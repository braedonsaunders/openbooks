import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { requestPayInformation } from "@openbooks/engine/src/hrm/compensation/pay-transparency.ts";

import { compensationErrorResponse } from "../compensation/_lib";
import { requestPayInfoBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Pay-information requests. POST files one for the caller's own
 * employment (hrm.self.request in the service — HR files nobody
 * else's); POST /[id] fulfils (from the latest snapshot covering the
 * worker's category, refusing when none does) or refuses with a
 * reason. Fulfil/refuse ride comp.manage. The client checks res.ok
 * before parsing.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrmPayTransparency",
  body: requestPayInfoBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const request = await requestPayInformation({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
      });
      return NextResponse.json({ request }, { status: 201 });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
