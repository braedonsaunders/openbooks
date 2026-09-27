import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { updateAutomation } from "@openbooks/engine/src/automations/services.ts";
import { isUuid } from "../../../../lib/list-params";
import { patchAutomationBody } from "../bodies";
import { automationErrorResponse } from "../_lib";


export { runtime } from "@/lib/api/route";

/** Single automation: GET reads, PATCH edits (bumps version). */
export const GET = defineRoute({
  permission: "automations.read",
  feature: "automations",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const ctx = { params };

    const { id } = await ctx.params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "automation id must be a uuid" },
        { status: 400 },
      );
    try {
      const { listAutomations } =
        await import("@openbooks/engine/src/automations/services.ts");
      const automations = await listAutomations(gate.user.orgId, gate.user.id);
      const automation = automations.find((a) => a.id === id);
      if (!automation)
        return NextResponse.json(
          { error: "automation not found" },
          { status: 404 },
        );
      return NextResponse.json({ automation });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "automations.manage",
  feature: "automations",
  params: z.object({ id: z.string() }),
  body: patchAutomationBody,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const ctx = { params };

    const { id } = await ctx.params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "automation id must be a uuid" },
        { status: 400 },
      );

    const body = routeBody;
    try {
      const automation = await updateAutomation({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        automationId: id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
        ...(body.rules !== undefined ? { rules: body.rules } : {}),
        ...(body.conditions !== undefined
          ? { conditions: body.conditions }
          : {}),
        ...(body.actions !== undefined ? { actions: body.actions } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.expectedVersion !== undefined
          ? { expectedVersion: body.expectedVersion }
          : {}),
      });
      return NextResponse.json({ automation });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
