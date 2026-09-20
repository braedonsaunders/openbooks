import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cancelCycle,
  closeCycle,
  cyclePacing,
  getCycle,
  listCycleLines,
  openCycle,
  pushCycle,
  setCycleBudgets,
  submitCycleForApproval,
} from "@openbooks/engine/src/hrm/compensation/cycles.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";
import { setBudgetsBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One merit cycle: GET reads the round with its lines and computed
 * budget pacing; POST {action} moves it — open, submit (the Flows run),
 * push (one wage write per approved line, idempotent), close, cancel,
 * budgets. Reads ride comp.read; every move rides comp.manage (line
 * decisions additionally need comp.approve in the service). The client
 * checks res.ok before parsing.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid cycle" }, { status: 400 });
  try {
    const cycle = await getCycle({ orgId: gate.user.orgId, actorId: gate.user.id, cycleId: id });
    const lines = await listCycleLines({ orgId: gate.user.orgId, actorId: gate.user.id, cycleId: id });
    const pacing = await cyclePacing(gate.user.orgId, id);
    return NextResponse.json({ cycle, lines, pacing });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

const ACTIONS = ["open", "submit", "push", "close", "cancel", "budgets"] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid cycle" }, { status: 400 });
  const parsedBody = await parseJsonBody(
    req,
    // Cancel carries a reason; budgets carries envelopes; the rest are bare actions.
    setBudgetsBody.or(
      z.object({
        action: z.enum(ACTIONS),
        reason: z.string().trim().min(1).max(2000).optional(),
      }),
    ),
  );
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { action?: string; reason?: string; budgets?: { departmentId?: string | null; managerPartyId?: string | null; currency: string; amount: string }[] };
  try {
    const q = { orgId: gate.user.orgId, actorId: gate.user.id, cycleId: id };
    switch (body.action) {
      case "open": {
        const opened = await openCycle(q);
        return NextResponse.json(opened, { status: 201 });
      }
      case "submit": {
        const cycle = await submitCycleForApproval(q);
        return NextResponse.json({ cycle });
      }
      case "push": {
        const result = await pushCycle(q);
        return NextResponse.json({ cycle: await getCycle(q), ...result });
      }
      case "close": {
        const cycle = await closeCycle(q);
        return NextResponse.json({ cycle });
      }
      case "cancel": {
        if (!body.reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
        const cycle = await cancelCycle({ ...q, reason: body.reason });
        return NextResponse.json({ cycle });
      }
      default: {
        if (!body.budgets) return NextResponse.json({ error: "unknown action" }, { status: 400 });
        await setCycleBudgets({ ...q, budgets: body.budgets });
        return NextResponse.json({ ok: true });
      }
    }
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
