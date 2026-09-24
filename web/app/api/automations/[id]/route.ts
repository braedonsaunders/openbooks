import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  updateAutomation,
} from "@openbooks/engine/src/automations/services.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { patchAutomationBody } from "../bodies";
import { automationErrorResponse } from "../_lib";

export const runtime = "nodejs";

/** Single automation: GET reads, PATCH edits (bumps version). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("automations.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });
  try {
    const { listAutomations } = await import("@openbooks/engine/src/automations/services.ts");
    const automations = await listAutomations(gate.user.orgId, gate.user.id);
    const automation = automations.find((a) => a.id === id);
    if (!automation) return NextResponse.json({ error: "automation not found" }, { status: 404 });
    return NextResponse.json({ automation });
  } catch (e) {
    return automationErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("automations.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchAutomationBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const automation = await updateAutomation({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      automationId: id,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
      ...(body.rules !== undefined ? { rules: body.rules } : {}),
      ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
      ...(body.actions !== undefined ? { actions: body.actions } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
    });
    return NextResponse.json({ automation });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
