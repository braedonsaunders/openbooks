import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { submitChangeRequest } from "@openbooks/engine/src/hrm/change-requests.ts";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { changeRequestErrorResponse } from "../../_lib";
import { submitChangeRequestBody } from "../../bodies";
/** Submit a draft employment change request for governed approval. */
export const POST = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrm",
  body: submitChangeRequestBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );
    try {
      // When hrmActionReasons is on, submit requires both action and
      // an active reason code; when off, classification is ignored entirely.
      const { validateSubmitActionReason } =
        await import("@openbooks/engine/src/automations/action-reasons.ts");
      const { automationErrorResponse } =
        await import("../../../../automations/_lib");
      try {
        await validateSubmitActionReason({
          orgId: gate.user.orgId,
          featureOn: await isFeatureEnabled(
            gate.user.orgId,
            "hrmActionReasons",
          ),
          ...(body.action ? { action: body.action } : {}),
          ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}),
          ...(body.reason ? { reason: body.reason } : {}),
        });
      } catch (e) {
        return automationErrorResponse(e);
      }
      const request = await submitChangeRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        reason: body.reason,
        ...(body.action ? { action: body.action } : {}),
        ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}),
      });
      return NextResponse.json({ request });
    } catch (e) {
      return changeRequestErrorResponse(e);
    }
  },
});
