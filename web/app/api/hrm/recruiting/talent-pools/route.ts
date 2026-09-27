import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createTalentPool,
  listTalentPools,
} from "@openbooks/engine/src/hrm/recruiting/pools.ts";

import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createTalentPoolBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Talent-pool collection: GET lists pools, POST creates one (manage gate
 * in the service). 404s while hrm, hrmRecruiting, or hrmTalentPool is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmTalentPool");
}

export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmTalentPool",
  handler: async ({ request: req, authz: gate }) => {
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
  feature: "hrmTalentPool",
  body: createTalentPoolBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
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
