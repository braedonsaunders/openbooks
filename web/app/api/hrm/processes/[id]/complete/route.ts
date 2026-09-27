import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { completeProcess } from "@openbooks/engine/src/hrm/processes.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { processErrorResponse } from "../../_lib";
import { completeProcessBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Complete an open checklist. Refused while a required step is pending —
 * the refusal names the pending steps, and the client renders it intact.
 */
export const POST = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: completeProcessBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "process id must be a uuid" },
        { status: 400 },
      );

    try {
      await completeProcess({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        processId: id,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});
