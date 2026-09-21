import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  listActionReasons,
  upsertActionReason,
} from "@openbooks/engine/src/automations/action-reasons.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { actionReasonRouteBody } from "../../automations/bodies";
import { automationErrorResponse } from "../../automations/_lib";

export const runtime = "nodejs";

/**
 * Action/reason codes (Setup-owned vocabulary). When hrmActionReasons is
 * off the route 404s and submit ignores classification entirely.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.employment.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmActionReasons"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    const reasons = await listActionReasons(
      gate.user.orgId,
      gate.user.id,
      action ?? undefined,
    );
    return NextResponse.json({ reasons });
  } catch (e) {
    return automationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.employment.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmActionReasons"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, actionReasonRouteBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const reason = await upsertActionReason({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      action: body.action,
      reasonCode: body.reasonCode,
      label: body.label,
      ...(body.requiresComment != null ? { requiresComment: body.requiresComment } : {}),
      ...(body.isActive != null ? { isActive: body.isActive } : {}),
    });
    return NextResponse.json({ reason }, { status: 201 });
  } catch (e) {
    return automationErrorResponse(e);
  }
}
