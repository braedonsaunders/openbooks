import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createPlan,
  listPlanLines,
  listPlans,
} from "@openbooks/engine/src/hrm/compensation/headcount-plans.ts";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { createPlanBody } from "../compensation/bodies";
/**
 * Headcount plans. GET lists plans (or one plan's costed lines through
 * ?planId=); POST creates a plan. Reads ride comp.read; writes ride
 * comp.manage. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.compensation.read",
  feature: "hrmCompensation",
  handler: async ({ request: req, authz: gate }) => {
    const planId = new URL(req.url).searchParams.get("planId");
    try {
      if (planId) {
        if (!isUuid(planId))
          return NextResponse.json(
            { error: "planId must be a uuid" },
            { status: 400 },
          );
        const lines = await listPlanLines({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          planId,
        });
        return NextResponse.json({ lines });
      }
      const plans = await listPlans({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ plans });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: createPlanBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    if (body.fiscalPeriodTo < body.fiscalPeriodFrom) {
      return NextResponse.json(
        { error: "fiscalPeriodTo must be on or after fiscalPeriodFrom" },
        { status: 400 },
      );
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
  },
});
