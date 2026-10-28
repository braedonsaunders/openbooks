import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { approveLine, proposeLine, reopenLine } from "@openbooks/engine/hrm/compensation/cycles";
import { guardPermission } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { compensationErrorResponse } from "../../../../compensation/_lib";
import { cycleLineBody } from "../../../../compensation/bodies";
import { meritCyclesPayrollRefusal } from "../../../_gate";

export const runtime = "nodejs";

/**
 * The proposal body. The percent and the rate are the two ways a
 * proposal may be expressed; the reason is what carries an
 * outside-guideline proposal, a reopen or a rejection. Each refusal is
 * the one the reviewer reads, so it is declared here rather than left
 * to a generic "expected number".
 */
/**
 * One cycle line: PATCH?action= proposes (the manager's own reports or
 * comp.manage, within guideline or with a reason), reopens a decided
 * line with a reason, or approves/rejects through the Flows gate key
 * with the decider distinct from the proposer. Pushed lines never
 * reopen. The action rides the query string; the body carries the
 * proposal or reason. The client checks res.ok before parsing.
 */
export const PATCH = defineRoute({
  authorize: async ({ request }) => {
    const action = new URL(request.url).searchParams.get("action");
    return guardPermission(
      action === "propose"
        ? "hrm.compensation.read"
        : action === "approve"
          ? "hrm.compensation.manage"
          : "hrm.compensation.approve",
    );
  },
  feature: "hrmCompensation",
  params: z.object({ id: z.string().min(1), lineId: z.string().min(1) }),
  body: cycleLineBody,
  handler: async ({ request: req, params: routeParams, body, authz: gate }) => {
    const { id, lineId } = routeParams;
    if (!isUuid(id) || !isUuid(lineId))
      return NextResponse.json({ error: "invalid cycle line" }, { status: 400 });
    const action = new URL(req.url).searchParams.get("action");

    if (action === "propose") {
      // Proposing is the manager's structural scope (or comp.manage in the
      // service) — the route needs only the read grant; the service fences.
      const featureGate = await meritCyclesPayrollRefusal(gate.user.orgId);
      if (featureGate) return featureGate;
      const proposedPct = body.proposedPct ?? null;
      const proposedRate = body.proposedRate ?? null;
      try {
        const line = await proposeLine({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          lineId,
          proposedPct,
          proposedRate,
          reason: body.reason ?? null,
        });
        return NextResponse.json({ line });
      } catch (e) {
        return compensationErrorResponse(e);
      }
    }
    const featureGate = await meritCyclesPayrollRefusal(gate.user.orgId);
    if (featureGate) return featureGate;
    const reason = body.reason?.trim() ? body.reason : null;
    try {
      const q = { orgId: gate.user.orgId, actorId: gate.user.id, lineId };
      if (action === "approve") {
        const line = await approveLine({ ...q, reason });
        return NextResponse.json({ line });
      }
      if (action === "reopen") {
        if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
        const line = await reopenLine({ ...q, reason });
        return NextResponse.json({ line });
      }
      return NextResponse.json(
        { error: "unknown action (propose, approve, reopen)" },
        { status: 400 },
      );
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
