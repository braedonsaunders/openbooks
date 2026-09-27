import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { upsertProcessTemplateStep } from "@openbooks/engine/src/hrm/processes.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { processErrorResponse } from "../../../processes/_lib";
import { saveProcessTemplateStepBody } from "../../bodies";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: saveProcessTemplateStepBody,
  handler: async ({
    authz: authz,
    params: routeParams,
    body: body,
  }) => {
    const id = routeParams.id;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "template id must be a uuid" },
        { status: 400 },
      );
    try {
      const step = await upsertProcessTemplateStep({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        templateId: id,
        ...body,
      });
      return NextResponse.json({ step }, { status: 201 });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});
