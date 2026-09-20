import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { completeProcessStep } from "@openbooks/engine/src/hrm/processes.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { processErrorResponse } from "../../../_lib";
import { completeStepBody } from "../../../bodies";

export const runtime = "nodejs";

/**
 * Complete one checklist step. Managers (hrm.process.manage) and the step's
 * own employee owner both arrive here — the service tells them apart, so
 * this route gates on the read grant and lets the service refuse strangers
 * with the remedy intact.
 */
export async function POST(req: Request, ctx: { params: Promise<{ stepId: string }> }) {
  const gate = await guardPermission("hrm.process.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { stepId } = await ctx.params;
  if (!isUuid(stepId)) return NextResponse.json({ error: "step id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, completeStepBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    await completeProcessStep({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      stepId,
      ...(parsedBody.data.attachmentId === undefined ? {} : { attachmentId: parsedBody.data.attachmentId }),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return processErrorResponse(e);
  }
}
