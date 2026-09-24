import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { simulateAutomation } from "@openbooks/engine/src/automations/simulator.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { simulateAutomationBody } from "../../bodies";
import { automationErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/**
 * Simulate: dry-run the recipe against a chosen subject (or the last N
 * real subjects) with NO writes. Requires the simulator sub-feature.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "automationSimulator"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, simulateAutomationBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if ((body.subjectEntity == null) !== (body.subjectId == null)) {
    return NextResponse.json(
      { error: "subjectEntity and subjectId travel together — pass both, or pass only an entity to sample" },
      { status: 400 },
    );
  }
  try {
    const simulations = await simulateAutomation({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      automationId: id,
      ...(body.subjectEntity ? { subjectEntity: body.subjectEntity } : {}),
      ...(body.subjectId ? { subjectId: body.subjectId } : {}),
      ...(body.sampleSize != null ? { sampleSize: body.sampleSize } : {}),
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ simulations });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
