import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { getExitRecord, updateExitRecord } from "@openbooks/engine/src/hrm/performance/exits.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchExitBody } from "../../exit-records/bodies";

export const runtime = "nodejs";

/**
 * One exit record: GET through the retention read gate (HR only); PATCH
 * corrects it (performance manage gate in the service). Deletes are
 * refused by trigger — corrections update the one row per employment. The
 * client checks res.ok before parsing.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.retention.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid exit record" }, { status: 400 });
  try {
    const exit = await getExitRecord({ orgId: gate.user.orgId, actorId: gate.user.id, exitId: id });
    return NextResponse.json({ exit });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.performance.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid exit record" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchExitBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const exit = await updateExitRecord({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      exitId: id,
      ...(body.reasonKind ? { reasonKind: body.reasonKind } : {}),
      ...(body.isVoluntary !== undefined ? { isVoluntary: body.isVoluntary } : {}),
      ...(body.isRegrettable !== undefined ? { isRegrettable: body.isRegrettable } : {}),
      ...(body.wouldRehire !== undefined ? { wouldRehire: body.wouldRehire } : {}),
      ...(body.interviewHeldOn !== undefined ? { interviewHeldOn: body.interviewHeldOn } : {}),
      ...(body.interviewerPartyId !== undefined ? { interviewerPartyId: body.interviewerPartyId } : {}),
      ...(body.destination !== undefined ? { destination: body.destination } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });
    return NextResponse.json({ exit });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
