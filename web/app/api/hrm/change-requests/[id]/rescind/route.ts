import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { rescindEmploymentChange } from "@openbooks/engine/src/automations/event-verbs.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { hrmAuthorizationResponse } from "../../../../../../lib/api/record-not-found";
import { isUuid } from "../../../../../../lib/list-params";
import { changeRequestErrorResponse } from "../../_lib";
import { automationErrorResponse } from "../../../../automations/_lib";
import { rescindBody } from "../../../../automations/bodies";
/**
 * Rescind a COMPLETED employment change: closes the version it created,
 * reopens the prior image, and appends the verb rescind event. Danger
 * action on a completed change; refuses with a dependent change or a
 * consumed payroll period.
 */
export const POST = defineRoute({
  permission: "hrm.employment.approve",
  feature: "hrmEventVerbs",
  body: rescindBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "change id must be a uuid" },
        { status: 400 },
      );
    try {
      const result = await rescindEmploymentChange({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        changeId: id,
        reason: body.reason,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (e) {
      // Uniform HRM mapping first — the permission regex below
      // must not swallow scope denials into the request-error shape.
      if (e instanceof HrmAuthorizationError)
        return hrmAuthorizationResponse(e);
      if (e instanceof Error && /requires the .* permission/.test(e.message)) {
        return changeRequestErrorResponse(e);
      }
      return automationErrorResponse(e);
    }
  },
});
