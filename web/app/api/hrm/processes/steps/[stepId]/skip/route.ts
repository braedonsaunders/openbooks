import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { skipProcessStep } from "@openbooks/engine/src/hrm/processes.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { isUuid } from "../../../../../../../lib/list-params";
import { processErrorResponse } from "../../../_lib";
import { skipStepBody } from "../../../bodies";

export const runtime = "nodejs";

/** Skip one checklist step with a reason (required skips need employment.manage in the service). */
export async function POST(req: Request, ctx: { params: Promise<{ stepId: string }> }) {
  const gate = await guardPermission("hrm.process.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { stepId } = await ctx.params;
  if (!isUuid(stepId)) return NextResponse.json({ error: "step id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, skipStepBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    await skipProcessStep({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      stepId,
      reason: parsedBody.data.reason,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return processErrorResponse(e);
  }
}
