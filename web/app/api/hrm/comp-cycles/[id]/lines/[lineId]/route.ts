import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  approveLine,
  proposeLine,
  rejectLine,
  reopenLine,
} from "@openbooks/engine/src/hrm/compensation/cycles.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { isUuid } from "../../../../../../../lib/list-params";
import { compensationErrorResponse } from "../../../../compensation/_lib";

export const runtime = "nodejs";

/**
 * One cycle line: PATCH?action= proposes (the manager's own reports or
 * comp.manage, within guideline or with a reason), reopens a decided
 * line with a reason, or approves/rejects through the Flows gate key
 * with the decider distinct from the proposer. Pushed lines never
 * reopen. The action rides the query string; the body carries the
 * proposal or reason. The client checks res.ok before parsing.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  if (!isUuid(id) || !isUuid(lineId)) return NextResponse.json({ error: "invalid cycle line" }, { status: 400 });
  const action = new URL(req.url).searchParams.get("action");
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    proposedPct?: unknown;
    proposedRate?: unknown;
    reason?: unknown;
  };
  if (action === "propose") {
    // Proposing is the manager's structural scope (or comp.manage in the
    // service) — the route needs only the read grant; the service fences.
    const gate = await guardPermission("hrm.compensation.read");
    if (gate instanceof NextResponse) return gate;
    if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const proposedPct = body.proposedPct ?? null;
    const proposedRate = body.proposedRate ?? null;
    if (proposedPct !== null && (typeof proposedPct !== "number" || !Number.isFinite(proposedPct) || proposedPct < 0)) {
      return NextResponse.json({ error: "proposedPct must be a non-negative percent" }, { status: 400 });
    }
    if (proposedRate !== null && (typeof proposedRate !== "string" || !/^\d+(\.\d{1,4})?$/.test(proposedRate))) {
      return NextResponse.json({ error: "proposedRate must be a positive amount with at most 4 decimals" }, { status: 400 });
    }
    try {
      const line = await proposeLine({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        lineId,
        proposedPct,
        proposedRate,
        reason: typeof body.reason === "string" ? body.reason : null,
      });
      return NextResponse.json({ line });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  }
  const gate = await guardPermission("hrm.compensation.approve");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason : null;
  try {
    const q = { orgId: gate.user.orgId, actorId: gate.user.id, lineId };
    if (action === "approve") {
      const line = await approveLine({ ...q, reason });
      return NextResponse.json({ line });
    }
    if (action === "reject" || action === "reopen") {
      if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
      const line = action === "reject" ? await rejectLine({ ...q, reason }) : await reopenLine({ ...q, reason });
      return NextResponse.json({ line });
    }
    return NextResponse.json({ error: "unknown action (propose, approve, reject, reopen)" }, { status: 400 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
