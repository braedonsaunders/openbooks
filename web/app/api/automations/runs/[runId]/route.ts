import { NextResponse } from "next/server";
import { getAutomationRun } from "@openbooks/engine/src/automations/services.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { automationErrorResponse } from "../../_lib";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/** Run drawer: one run with its steps and error. */
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return notFound("record");
  }
  const { runId } = await ctx.params;
  if (!isUuid(runId)) return NextResponse.json({ error: "run id must be a uuid" }, { status: 400 });
  try {
    const run = await getAutomationRun(gate.user.orgId, gate.user.id, runId, gate.allowedSubsidiaryIds);
    return NextResponse.json({ run });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
