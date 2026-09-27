import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  cancelInterview,
  completeInterview,
} from "@openbooks/engine/src/hrm/recruiting/interviews.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchInterviewBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One interview: PATCH completes a sitting with its verdict or cancels a
 * scheduled one — through an action-discriminated body. Completed sittings
 * stand as recorded.
 */
export const PATCH = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: patchInterviewBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid interview" }, { status: 400 });

    try {
      if (body.action === "complete") {
        const interview = await completeInterview({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          interviewId: id,
          outcome: body.outcome,
          feedback: body.feedback,
          scorecard: body.scorecard,
        });
        return NextResponse.json({ interview });
      }
      const interview = await cancelInterview({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
      });
      return NextResponse.json({ interview });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
