import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createAutomation,
  listAutomations,
} from "@openbooks/engine/src/automations/services.ts";
import { guardPermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { createAutomationBody } from "./bodies";
import { automationErrorResponse } from "./_lib";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/** Automation recipes: GET lists, POST authors a draft recipe. */
export async function GET() {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return notFound("record");
  }
  try {
    const automations = await listAutomations(gate.user.orgId, gate.user.id);
    return NextResponse.json({ automations });
  } catch (e) {
    return automationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("automations.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return notFound("record");
  }
  const parsedBody = await parseJsonBody(req, createAutomationBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
