import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { rescindEmploymentChange } from "@openbooks/engine/src/automations/event-verbs.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { changeRequestErrorResponse } from '../../_lib';
import { automationErrorResponse } from "../../../../automations/_lib";
import { rescindBody } from "../../../../automations/bodies";

export const runtime = "nodejs";

/**
 * Rescind a COMPLETED employment change: closes the version it created,
 * reopens the prior image, and appends the verb rescind event. Danger
 * action on a completed change; refuses with a dependent change or a
 * consumed payroll period.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.employment.approve");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmEventVerbs"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "change id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, rescindBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const result = await rescindEmploymentChange({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      changeId: id,
      reason: parsedBody.data.reason,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof Error && /requires the .* permission/.test(e.message)) {
      return changeRequestErrorResponse(e);
    }
    return automationErrorResponse(e);
  }
}
