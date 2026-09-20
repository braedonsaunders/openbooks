import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createCycle,
  listCycles,
} from "@openbooks/engine/src/hrm/compensation/cycles.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { compensationErrorResponse } from "../compensation/_lib";
import { createCycleBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Merit cycles. GET lists through the compensation read gate; POST opens
 * a draft round through the manage gate. Gated on hrmMeritCycles (which
 * requires payroll — the push writes wages and the open reads pay
 * truth). The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const cycles = await listCycles({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ cycles });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createCycleBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
