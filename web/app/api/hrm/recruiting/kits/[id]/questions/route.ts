import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { addKitQuestion } from "@openbooks/engine/src/hrm/recruiting/kits.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { createQuestionBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Kit questions: POST appends a suggested question at an explicit position,
 * optionally pinned to one of the kit's attributes (manage gate in the
 * service). 404s while HRM or Recruiting is off.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: createQuestionBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const question = await addKitQuestion({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        kitId: id,
        question: body.question,
        position: body.position,
        attributeId: body.attributeId,
      });
      return NextResponse.json({ question }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
