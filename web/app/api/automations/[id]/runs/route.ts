import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { listAutomationRuns } from "@openbooks/engine/src/automations/services.ts";
import { isUuid } from "../../../../../lib/list-params";
import { automationErrorResponse } from "../../_lib";


export const runtime = "nodejs";

/** Runs tab: the automation's run log, filterable by status. */
export const GET = defineRoute({
  permission: "automations.read",
  feature: "automations",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    const ctx = { params };

    const { id } = await ctx.params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "automation id must be a uuid" },
        { status: 400 },
      );
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    try {
      const runs = await listAutomationRuns(
        gate.user.orgId,
        gate.user.id,
        id,
        status ?? undefined,
        gate.allowedSubsidiaryIds,
      );
      return NextResponse.json({ runs });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
