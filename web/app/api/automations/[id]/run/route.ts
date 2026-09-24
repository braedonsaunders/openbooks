import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { executeAutomation } from "@openbooks/engine/src/automations/execute.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { runAutomationBody } from "../../bodies";
import { automationErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/**
 * Run-now: fire one enabled automation immediately (manual trigger with an
 * optional subject). The idempotency key makes a double-click or replayed
 * request collapse onto one run row — never a double-run.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("automations.run");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, runAutomationBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if ((body.subjectEntity == null) !== (body.subjectId == null)) {
    return NextResponse.json(
      { error: "subjectEntity and subjectId travel together — pass both or neither" },
      { status: 400 },
    );
  }
  try {
    const run = await executeAutomation({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      automationId: id,
      ...(body.subjectEntity ? { subjectEntity: body.subjectEntity, subjectId: body.subjectId ?? null } : {}),
      triggerPayload: { kind: "manual" },
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
