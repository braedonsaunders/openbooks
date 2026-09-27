import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { simulateAutomation } from "@openbooks/engine/src/automations/simulator.ts";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { simulateAutomationBody } from "../../bodies";
import { automationErrorResponse } from "../../_lib";
import { notFound } from "@/lib/api/responses";


export { runtime } from "@/lib/api/route";

/**
 * Simulate: dry-run the recipe against a chosen subject (or the last N
 * real subjects) with NO writes. Requires the simulator sub-feature.
 */
export const POST = defineRoute({
  permission: "automations.read",
  feature: "automations",
  params: z.object({ id: z.string() }),
  body: simulateAutomationBody,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const ctx = { params };

    if (!(await isFeatureEnabled(gate.user.orgId, "automationSimulator"))) {
      return notFound("record");
    }
    const { id } = await ctx.params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "automation id must be a uuid" },
        { status: 400 },
      );

    const body = routeBody;
    if ((body.subjectEntity == null) !== (body.subjectId == null)) {
      return NextResponse.json(
        {
          error:
            "subjectEntity and subjectId travel together — pass both, or pass only an entity to sample",
        },
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
  },
});
