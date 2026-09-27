import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { executeAutomation } from "@openbooks/engine/src/automations/execute.ts";
import { isUuid } from "../../../../../lib/list-params";
import { runAutomationBody } from "../../bodies";
import { automationErrorResponse } from "../../_lib";


export { runtime } from "@/lib/api/route";

/**
 * Run-now: fire one enabled automation immediately (manual trigger with an
 * optional subject). The idempotency key makes a double-click or replayed
 * request collapse onto one run row — never a double-run.
 */
export const POST = defineRoute({
  permission: "automations.run",
  feature: "automations",
  params: z.object({ id: z.string() }),
  body: runAutomationBody,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const ctx = { params };

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
            "subjectEntity and subjectId travel together — pass both or neither",
        },
        { status: 400 },
      );
    }
    try {
      const run = await executeAutomation({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        automationId: id,
        ...(body.subjectEntity
          ? {
              subjectEntity: body.subjectEntity,
              subjectId: body.subjectId ?? null,
            }
          : {}),
        triggerPayload: { kind: "manual" },
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ run }, { status: 201 });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
