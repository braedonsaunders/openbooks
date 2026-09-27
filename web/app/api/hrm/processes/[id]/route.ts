import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getProcess } from "@openbooks/engine/src/hrm/processes-read.ts";

import { isUuid } from "../../../../../lib/list-params";
import { processErrorResponse } from "../_lib";

export const runtime = "nodejs";

/** Single process checklist with its steps, owners, due dates, and evidence. */
export const GET = defineRoute({
  permission: "hrm.process.read",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "process id must be a uuid" },
        { status: 400 },
      );
    try {
      const process = await getProcess({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        processId: id,
      });
      return NextResponse.json({ process });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});
