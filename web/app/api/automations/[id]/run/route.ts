import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { executeAutomation } from "@openbooks/engine/automations/execute";
import { isUuid } from "../../../../../lib/list-params";
import { runAutomationBody } from "../../bodies";
import { automationErrorResponse, resolveRunInvocationKey } from "../../_lib";

export const runtime = "nodejs";

/**
 * Run-now: fire one enabled automation immediately (manual trigger with an
 * optional subject). An Idempotency-Key header makes a retried or
 * double-submitted request collapse onto one run row; without the header
 * every request is a new invocation and runs anew.
 */
export const POST = defineRoute({
  permission: "automations.run",
  feature: "automations",
  params: z.object({ id: z.string() }),
  body: runAutomationBody,
  handler: async ({ request, authz: gate, params, body: routeBody }) => {
    const ctx = { params };

    const { id } = await ctx.params;
    if (!isUuid(id))
      return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });

    const invocation = resolveRunInvocationKey(
      request.headers.get("Idempotency-Key"),
      gate.user.id,
    );
    if (!invocation.ok) {
      return NextResponse.json({ error: invocation.error }, { status: 400 });
    }

    const body = routeBody;
    if ((body.subjectEntity == null) !== (body.subjectId == null)) {
      return NextResponse.json(
        {
          error: "subjectEntity and subjectId travel together — pass both or neither",
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
        fingerprint: invocation.fingerprint,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ run }, { status: 201 });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
