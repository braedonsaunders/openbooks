import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { submitChangeRequest } from "@openbooks/engine/src/hrm/change-requests.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { changeRequestErrorResponse } from "../../_lib";
import { submitChangeRequestBody } from "../../bodies";

export const runtime = "nodejs";

/** Submit a draft employment change request for governed approval. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.employment.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "request id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, submitChangeRequestBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    // HR-16: when hrmActionReasons is on, submit requires both action and
    // an active reason code; when off, classification is ignored entirely.
    const { validateSubmitActionReason } = await import(
      "@openbooks/engine/src/automations/action-reasons.ts"
    );
    const { automationErrorResponse } = await import("../../../automations/_lib");
    try {
      await validateSubmitActionReason({
        orgId: gate.user.orgId,
        featureOn: await isFeatureEnabled(gate.user.orgId, "hrmActionReasons"),
        ...(body.action ? { action: body.action } : {}),
        ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
      });
    } catch (e) {
      return automationErrorResponse(e);
    }
    const request = await submitChangeRequest({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requestId: id,
      reason: body.reason,
      ...(body.action ? { action: body.action } : {}),
      ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}),
    });
    return NextResponse.json({ request });
  } catch (e) {
    return changeRequestErrorResponse(e);
  }
}
