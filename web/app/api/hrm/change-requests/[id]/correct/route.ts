import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { correctEmploymentChange } from "@openbooks/engine/src/automations/event-verbs.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { automationErrorResponse } from "../../../../automations/_lib";
import { correctBody } from "../../../../automations/bodies";

export const runtime = "nodejs";

/**
 * Correct a completed employment change. Default: opens a NEW pre-filled
 * change request (correct_requires_reapproval) — the correction still
 * passes approval. Direct application only when the org allows it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.employment.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmEventVerbs"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "change id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, correctBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const result = await correctEmploymentChange({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      changeId: id,
      reason: body.reason,
      ...(body.correctedFields ? { correctedFields: body.correctedFields as Record<string, unknown> } : {}),
      ...(body.prefillPayload ? { prefillPayload: body.prefillPayload as Record<string, unknown> } : {}),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
