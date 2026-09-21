import { NextResponse } from "next/server";
import { explainPayslip } from "@openbooks/engine/src/hrm/ai/explain-pay.ts";
import { aiRailsErrorResponse, requireAnyPerm, uuidParam } from "../../../../lib/ai-rails";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

/**
 * Explain one payslip. GET reads the deterministic trace (components,
 * inputs, treatments, net, diff vs previous) for own stubs through
 * self-service or any stub through the payroll/HR grant. The drawer on
 * the Me payslip renders this trace as a table; the assistant phrases
 * it on request, citing the same record ids.
 */
export async function GET(req: Request) {
  const gate = await requireAnyPerm(["hrm.self.read", "hrm.employment.read", "payroll.manage"]);
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmExplainPay"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const employmentId = uuidParam(url, "employmentId", true);
  if (employmentId instanceof NextResponse) return employmentId;
  const stubId = uuidParam(url, "stubId", false);
  if (stubId instanceof NextResponse) return stubId;
  try {
    const trace = await explainPayslip({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId,
      stubId,
    });
    return NextResponse.json({ trace });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}
