import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withdrawChangeRequest } from "@openbooks/engine/hrm/change-requests/operations";
import { guardPermission } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { changeRequestErrorResponse } from "../../_lib";
import { withdrawChangeRequestBody } from "../../bodies";
/**
 * Withdraw a draft or pending employment change request — HR through
 * hrm.employment.manage for any request, or the requester through
 * hrm.self.request for their own profile-change request (the engine
 * enforces own-employment and kind; anything else keeps the manage refusal).
 */
export const POST = defineRoute({
  authorize: async () => {
    const hr = await guardPermission("hrm.employment.manage");
    return hr instanceof NextResponse ? await guardPermission("hrm.self.request") : hr;
  },
  feature: "hrm",
  params: z.object({
    id: z.string().refine(isUuid, { message: "request id must be a uuid" }),
  }),
  body: withdrawChangeRequestBody,
  handler: async ({ params, body, authz: gate }) => {
    const { id } = params;
    try {
      const request = await withdrawChangeRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        reason: body.reason,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return changeRequestErrorResponse(e);
    }
  },
});
