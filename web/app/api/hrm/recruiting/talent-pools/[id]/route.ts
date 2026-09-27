import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { deleteTalentPool } from "@openbooks/engine/src/hrm/recruiting/pools.ts";

import { recruitingErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/**
 * One talent pool: DELETE removes the pool (memberships follow; candidates
 * are untouched — deleting a pool never deletes a person). 404s while hrm,
 * hrmRecruiting, or hrmTalentPool is off.
 */
export const DELETE = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmTalentPool",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      await deleteTalentPool({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        poolId: id,
      });
      return NextResponse.json({ deleted: id });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
