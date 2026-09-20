import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createPlan,
  listPlanLines,
  listPlans,
} from "@openbooks/engine/src/hrm/compensation/headcount-plans.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { createPlanBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Headcount plans. GET lists plans (or one plan's costed lines through
 * ?planId=); POST creates a plan. Reads ride comp.read; writes ride
 * comp.manage. The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmHeadcountPlans"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const planId = new URL(req.url).searchParams.get("planId");
  try {
    if (planId) {
      if (!isUuid(planId)) return NextResponse.json({ error: "planId must be a uuid" }, { status: 400 });
      const lines = await listPlanLines({ orgId: gate.user.orgId, actorId: gate.user.id, planId });
      return NextResponse.json({ lines });
    }
    const plans = await listPlans({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ plans });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmHeadcountPlans"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createPlanBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (body.fiscalPeriodTo < body.fiscalPeriodFrom) {
    return NextResponse.json({ error: "fiscalPeriodTo must be on or after fiscalPeriodFrom" }, { status: 400 });
  }
  try {
    const plan = await createPlan({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      name: body.name,
      fiscalPeriodFrom: body.fiscalPeriodFrom,
      fiscalPeriodTo: body.fiscalPeriodTo,
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
