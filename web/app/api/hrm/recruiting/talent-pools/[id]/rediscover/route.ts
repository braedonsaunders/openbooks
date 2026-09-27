import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { rediscoverForRequisition } from "@openbooks/engine/src/hrm/recruiting/pools.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { rediscoverBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Pool rediscovery: POST matches pool members to an open requisition by
 * declared tags — a read returning names + matched tags only (no PII, no
 * AI). 404s while HRM or Recruiting is off.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: rediscoverBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const matches = await rediscoverForRequisition({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        poolId: id,
        requisitionId: body.requisitionId,
        requisitionTags: body.requisitionTags,
      });
      return NextResponse.json({ matches });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
