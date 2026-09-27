import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getAutomationRun } from "@openbooks/engine/src/automations/services.ts";
import { isUuid } from "../../../../../lib/list-params";
import { automationErrorResponse } from "../../_lib";


export { runtime } from "@/lib/api/route";

/** Run drawer: one run with its steps and error. */
export const GET = defineRoute({
  permission: "automations.read",
  feature: "automations",
  params: z.object({ runId: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const ctx = { params };

    const { runId } = await ctx.params;
    if (!isUuid(runId))
      return NextResponse.json(
        { error: "run id must be a uuid" },
        { status: 400 },
      );
    try {
      const run = await getAutomationRun(
        gate.user.orgId,
        gate.user.id,
        runId,
        gate.allowedSubsidiaryIds,
      );
      return NextResponse.json({ run });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
