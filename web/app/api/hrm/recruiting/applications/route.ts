import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { createApplication } from "@openbooks/engine/src/hrm/recruiting/applications.ts";

import { recruitingErrorResponse } from "../_lib";
import { createApplicationBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Applications collection: POST attaches a candidate to an open requisition
 * at the funnel's first stage (manage gate in the service). The pair is
 * unique — a second attach refuses by name.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: createApplicationBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
    try {
      const application = await createApplication({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: body.requisitionId,
        candidateId: body.candidateId,
        merged: body.merged,
      });
      return NextResponse.json({ application }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
