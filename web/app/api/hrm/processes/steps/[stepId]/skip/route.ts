import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { skipProcessStep } from "@openbooks/engine/src/hrm/processes.ts";

import { isUuid } from "../../../../../../../lib/list-params";
import { processErrorResponse } from "../../../_lib";
import { skipStepBody } from "../../../bodies";

export const runtime = "nodejs";

/** Skip one checklist step with a reason (required skips need employment.manage in the service). */
export const POST = defineRoute({
  permission: "hrm.process.read",
  feature: "hrm",
  params: z.object({ stepId: z.string().min(1) }),
  body: skipStepBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { stepId } = routeParams;
    if (!isUuid(stepId))
      return NextResponse.json(
        { error: "step id must be a uuid" },
        { status: 400 },
      );

    try {
      await skipProcessStep({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        stepId,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});
