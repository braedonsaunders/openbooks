import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { withdrawChangeRequest } from "@openbooks/engine/src/hrm/change-requests.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";
import { changeRequestErrorResponse } from "../../_lib";
import { withdrawChangeRequestBody } from "../../bodies";
/**
 * Withdraw a draft or pending employment change request — HR through
 * hrm.employment.manage for any request, or the requester through
 * hrm.self.request for their own profile-change request (the engine
 * enforces own-employment and kind; anything else keeps the manage refusal).
 */
export const POST = defineRoute({
  public: "session",
  feature: "hrm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, params }) => {
    const hr = await guardPermission("hrm.employment.manage");
    const gate =
      hr instanceof NextResponse
        ? await guardPermission("hrm.self.request")
        : hr;
    if (gate instanceof NextResponse) return gate;
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );
    const parsedBody = await parseJsonBody(req, withdrawChangeRequestBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      const request = await withdrawChangeRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        reason: parsedBody.data.reason,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return changeRequestErrorResponse(e);
    }
  },
});
