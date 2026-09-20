import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { setAutomationStatus } from "@openbooks/engine/src/automations/services.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { automationStatusBody } from "../../bodies";
import { automationErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/** Enable/disable an automation (enabling re-validates the recipe). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("automations.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "automations"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "automation id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, automationStatusBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const automation = await setAutomationStatus({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      automationId: id,
      status: parsedBody.data.status,
    });
    return NextResponse.json({ automation });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
