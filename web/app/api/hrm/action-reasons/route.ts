import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listActionReasons,
  upsertActionReason,
} from "@openbooks/engine/src/automations/action-reasons.ts";
import { actionReasonRouteBody } from "../../automations/bodies";
import { automationErrorResponse } from "../../automations/_lib";
/**
 * Action/reason codes (Setup-owned vocabulary). When hrmActionReasons is
 * off the route 404s and submit ignores classification entirely.
 */
export const GET = defineRoute({
  permission: "hrm.employment.read",
  feature: "hrmActionReasons",
  handler: async ({ request: req, authz: gate }) => {
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
  },
});
export const POST = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrmActionReasons",
  body: actionReasonRouteBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const reason = await upsertActionReason({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        action: body.action,
        reasonCode: body.reasonCode,
        label: body.label,
        ...(body.requiresComment != null
          ? { requiresComment: body.requiresComment }
          : {}),
        ...(body.isActive != null ? { isActive: body.isActive } : {}),
      });
      return NextResponse.json({ reason }, { status: 201 });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
