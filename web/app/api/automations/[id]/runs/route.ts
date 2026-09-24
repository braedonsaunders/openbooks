import { NextResponse } from "next/server";
import { listAutomationRuns } from "@openbooks/engine/src/automations/services.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { automationErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/** Runs tab: the automation's run log, filterable by status. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });
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
}
