import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createAutomation,
  listAutomations,
} from "@openbooks/engine/src/automations/services.ts";
import { createAutomationBody } from "./bodies";
import { automationErrorResponse } from "./_lib";


export { runtime } from "@/lib/api/route";

/** Automation recipes: GET lists, POST authors a draft recipe. */
export const GET = defineRoute({
  permission: "automations.read",
  feature: "automations",
  handler: async ({ authz: gate }) => {
    try {
      const automations = await listAutomations(gate.user.orgId, gate.user.id);
      return NextResponse.json({ automations });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "automations.manage",
  feature: "automations",
  body: createAutomationBody,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const body = routeBody;
    try {
      const automation = await createAutomation({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        rules: body.rules,
        conditions: body.conditions,
        actions: body.actions,
        ...(body.priority != null ? { priority: body.priority } : {}),
      });
      return NextResponse.json({ automation }, { status: 201 });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
