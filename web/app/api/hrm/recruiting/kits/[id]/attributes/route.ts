import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { addKitAttribute } from "@openbooks/engine/src/hrm/recruiting/kits.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { createAttributeBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Kit attributes: POST appends a rated attribute at an explicit position
 * (manage gate in the service). 404s while hrm, hrmRecruiting, or
 * hrmStructuredInterviews is off.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmStructuredInterviews",
  params: z.object({ id: z.string().min(1) }),
  body: createAttributeBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const attribute = await addKitAttribute({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        kitId: id,
        category: body.category,
        attribute: body.attribute,
        description: body.description,
        position: body.position,
        isFocusDefault: body.isFocusDefault,
      });
      return NextResponse.json({ attribute }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
