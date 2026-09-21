import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  moveApplicationStage,
  rejectApplication,
  withdrawApplication,
} from "@openbooks/engine/src/hrm/recruiting/applications.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchApplicationBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One application: PATCH moves the candidacy within its own funnel,
 * rejects with a reason, or withdraws — through an action-discriminated
 * body. The route gates on the read grant; beneath it the service admits
 * the hiring manager to MOVES on their own funnel without the manage
 * grant, while reject and withdraw need the grant in full. Every
 * transition appends its evidence in the same transaction.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid application" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchApplicationBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "move") {
      const application = await moveApplicationStage({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        applicationId: id,
        toStageId: body.toStageId,
        reason: body.reason,
      });
      return NextResponse.json({ application });
    }
    if (body.action === "reject") {
      const application = await rejectApplication({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        applicationId: id,
        reason: body.reason,
      });
      return NextResponse.json({ application });
    }
    const application = await withdrawApplication({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      applicationId: id,
    });
    return NextResponse.json({ application });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
