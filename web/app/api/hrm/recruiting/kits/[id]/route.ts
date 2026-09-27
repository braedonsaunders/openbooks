import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  deleteKit,
  setKitActive,
} from "@openbooks/engine/src/hrm/recruiting/kits.ts";

import { isFeatureEnabled } from "../../../../../../lib/features";
import { recruitingErrorResponse } from "../../_lib";
import { setKitActiveBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One interview kit: PATCH setActive retires/reactivates, DELETE removes a
 * kit with no sittings (a kit with interviews refuses by name). 404s while
 * hrm, hrmRecruiting, or hrmStructuredInterviews is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmStructuredInterviews");
}

export const PATCH = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmStructuredInterviews",
  params: z.object({ id: z.string().min(1) }),
  body: setKitActiveBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const kit = await setKitActive({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        kitId: id,
        isActive: body.isActive,
      });
      return NextResponse.json({ kit });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const DELETE = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmStructuredInterviews",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      await deleteKit({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        kitId: id,
      });
      return NextResponse.json({ deleted: id });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
