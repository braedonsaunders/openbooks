import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  cancelRequisition,
  holdRequisition,
  openRequisition,
  resumeRequisition,
} from "@openbooks/engine/src/hrm/recruiting/requisitions.ts";
import { getRequisitionDetail } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchRequisitionBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One requisition: GET resolves the drawer (pipeline chips, funnel,
 * applications) through the read service — which redacts candidate PII for
 * viewers without the read grant and admits the hiring manager on their own
 * openings; PATCH opens, holds, resumes, or cancels through an
 * action-discriminated body (the fill rides hire, never this endpoint).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid requisition" }, { status: 400 });
  try {
    const requisition = await getRequisitionDetail({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requisitionId: id,
    });
    return NextResponse.json({ requisition });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid requisition" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchRequisitionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "open") {
      const requisition = await openRequisition({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: id,
        targetStartOn: body.targetStartOn,
        overEstablishment: body.overEstablishment,
      });
      return NextResponse.json({ requisition });
    }
    if (body.action === "hold") {
      const requisition = await holdRequisition({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: id,
        reason: body.reason,
      });
      return NextResponse.json({ requisition });
    }
    if (body.action === "resume") {
      const requisition = await resumeRequisition({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: id,
        reason: body.reason,
      });
      return NextResponse.json({ requisition });
    }
    const requisition = await cancelRequisition({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requisitionId: id,
      reason: body.reason,
    });
    return NextResponse.json({ requisition });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
