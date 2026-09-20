import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  approvePlan,
  closePlan,
  createPlanLine,
  submitPlan,
} from "@openbooks/engine/src/hrm/compensation/headcount-plans.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";
import { createPlanLineBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One headcount plan: POST {action: line} costs and appends a line
 * (band target or incumbent rate plus burden, inputs in cost_basis);
 * POST {action: submit/approve/close} moves the plan. Terminate lines
 * are informational and never end employments. The client checks res.ok
 * before parsing.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmHeadcountPlans"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid plan" }, { status: 400 });
  const parsedBody = await parseJsonBody(
    req,
    z.object({ action: z.enum(["line", "submit", "approve", "close"]) }).and(createPlanLineBody.partial()),
  );
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const q = { orgId: gate.user.orgId, actorId: gate.user.id, planId: id };
  try {
    switch (body.action) {
      case "line": {
        if (!body.kind || !body.title || !body.employerSubsidiaryId || !body.plannedFte || !body.startOn || !body.currency) {
          return NextResponse.json({ error: "kind, title, employerSubsidiaryId, plannedFte, startOn and currency are required" }, { status: 400 });
        }
        const line = await createPlanLine({
          orgId: q.orgId,
          actorId: q.actorId,
          planId: id,
          kind: body.kind,
          positionId: body.positionId ?? null,
          title: body.title,
          departmentId: body.departmentId ?? null,
          employerSubsidiaryId: body.employerSubsidiaryId,
          jobLevelId: body.jobLevelId ?? null,
          plannedFte: body.plannedFte,
          startOn: body.startOn,
          endOn: body.endOn ?? null,
          currency: body.currency,
          reason: body.reason ?? null,
        });
        return NextResponse.json({ line }, { status: 201 });
      }
      case "submit":
        return NextResponse.json({ plan: await submitPlan(q) });
      case "approve":
        return NextResponse.json({ plan: await approvePlan(q) });
      case "close":
        return NextResponse.json({ plan: await closePlan(q) });
    }
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
