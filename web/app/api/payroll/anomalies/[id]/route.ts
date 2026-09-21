import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveFlag } from "@openbooks/engine/src/hrm/ai/anomalies.ts";
import { aiRailsErrorResponse, requireAnyPerm } from "../../../../../lib/ai-rails";
import { isFeatureEnabled } from "../../../../../lib/features";

export const runtime = "nodejs";

const transitionBody = z.object({
  to: z.enum(["acknowledged", "resolved", "false_positive"]),
  reason: z.string().min(1).max(500),
});

/**
 * Transition one flag. Acknowledge, resolve, or mark false-positive —
 * every target needs the reason the audit keeps. Blocking flags resolve
 * or dismiss only through the payroll manager (enforced in the service);
 * false-positives feed the per-org suppression list. One transaction.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAnyPerm(["payroll.manage", "time.approve", "hrm.employment.read"]);
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrmPayrollAnomalies")) &&
    !(await isFeatureEnabled(gate.user.orgId, "hrmTimeAnomalies"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: "flag id must be a uuid" }, { status: 400 });
  }
  const parsedBody = await parseJsonBody(req, transitionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const flag = await resolveFlag({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      flagId: id,
      to: body.to,
      reason: body.reason,
    });
    return NextResponse.json({ flag });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}
