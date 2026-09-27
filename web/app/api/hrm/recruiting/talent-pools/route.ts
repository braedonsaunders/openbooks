import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createTalentPool,
  listTalentPools,
} from "@openbooks/engine/src/hrm/recruiting/pools.ts";

import { recruitingErrorResponse } from "../_lib";
import { createTalentPoolBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Talent-pool collection: GET lists pools, POST creates one (manage gate
 * in the service). 404s while HRM or Recruiting is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  handler: async ({ authz: gate }) => {
    try {
      const pools = await listTalentPools({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ pools });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: createTalentPoolBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const pool = await createTalentPool({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        name: body.name,
        description: body.description,
      });
      return NextResponse.json({ pool }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
