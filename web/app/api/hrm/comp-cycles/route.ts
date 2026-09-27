import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createCycle,
  listCycles,
} from "@openbooks/engine/src/hrm/compensation/cycles.ts";

import { compensationErrorResponse } from "../compensation/_lib";
import { createCycleBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Merit cycles. GET lists through the compensation read gate; POST opens
 * a draft round through the manage gate. Gated on hrmMeritCycles (which
 * requires payroll — the push writes wages and the open reads pay
 * truth). The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.compensation.read",
  feature: "hrmMeritCycles",
  handler: async ({ request: req, authz: gate }) => {
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
  feature: "hrmMeritCycles",
  body: createCycleBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
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
