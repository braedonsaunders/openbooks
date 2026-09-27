import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createCycle,
  listCycles,
} from "@openbooks/engine/src/hrm/compensation/cycles.ts";

import { compensationErrorResponse } from "../compensation/_lib";
import { meritCyclesPayrollRefusal } from "./_gate";
import { createCycleBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Merit cycles. GET lists through the compensation read gate; POST opens
 * a draft round through the manage gate. Gated on Compensation plus
 * Payroll (the push writes wages and the open reads pay truth). The
 * client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.compensation.read",
  feature: "hrmCompensation",
  handler: async ({ authz: gate }) => {
    const payrollOff = await meritCyclesPayrollRefusal(gate.user.orgId);
    if (payrollOff) return payrollOff;
    try {
      const cycles = await listCycles({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ cycles });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: createCycleBody,
  handler: async ({ authz: gate, body: body }) => {
    const payrollOff = await meritCyclesPayrollRefusal(gate.user.orgId);
    if (payrollOff) return payrollOff;
    try {
      const cycle = await createCycle({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        name: body.name,
        kind: body.kind,
        effectiveOn: body.effectiveOn,
        budgetBasis: body.budgetBasis ?? "combined",
        budgetTotal: body.budgetTotal ?? null,
        currency: body.currency,
        guidelineKind: body.guidelineKind,
        guideline: body.guideline as Record<string, unknown>,
        scope: body.scope ?? {},
      });
      return NextResponse.json({ cycle }, { status: 201 });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
