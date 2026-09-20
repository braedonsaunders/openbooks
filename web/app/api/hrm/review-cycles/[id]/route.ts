import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  closeCycle,
  moveToCalibrating,
  openCycle,
} from "@openbooks/engine/src/hrm/performance/review-cycles.ts";
import { getCycleDetail } from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { getAuthz, guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { performanceErrorResponse } from "../../compensation/_lib";
import { patchCycleBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One review cycle: GET resolves the cycle with its readable reviews and
 * progress (privacy scope in the service — an unreadable id 404s
 * uniformly); PATCH opens, moves to calibrating, or closes through an
 * action-discriminated body (performance manage gate in the service). The
 * client checks res.ok before parsing: whole-call denials are HTTP errors
 * with `{ error }` bodies.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid review cycle" }, { status: 400 });
  try {
    const cycle = await getCycleDetail({ orgId: authz.user.orgId, actorId: authz.user.id, cycleId: id });
    return NextResponse.json({ cycle });
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
  if (!isUuid(id)) return NextResponse.json({ error: "invalid review cycle" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchCycleBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "open") {
      const opened = await openCycle({ orgId: gate.user.orgId, actorId: gate.user.id, cycleId: id });
      return NextResponse.json(opened);
    }
    if (body.action === "to-calibrating") {
      const cycle = await moveToCalibrating({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        cycleId: id,
        force: body.force ?? false,
        forceReason: body.forceReason,
      });
      return NextResponse.json({ cycle });
    }
    const cycle = await closeCycle({ orgId: gate.user.orgId, actorId: gate.user.id, cycleId: id });
    return NextResponse.json({ cycle });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
