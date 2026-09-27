import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { cancelProcess } from "@openbooks/engine/src/hrm/processes.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { processErrorResponse } from "../../_lib";
import { cancelProcessBody } from "../../bodies";

export const runtime = "nodejs";

/** Cancel an open checklist with a reason — history keeps the cancelled row. */
export const POST = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: cancelProcessBody,
  handler: async ({
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
      await cancelProcess({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        processId: id,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});
