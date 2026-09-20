import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  generateBenefitPayrollInputs,
  voidBenefitPayrollInput,
} from "@openbooks/engine/src/hrm/benefits/benefits-payroll.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { benefitsErrorResponse } from "../_lib";
import { benefitPayrollInputsBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Benefit pay-run inputs: generate rows for a coverage month, or void one
 * with a reason. Manage grant; HR owns generation, payroll owns the run.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, benefitPayrollInputsBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "void") {
      const input = await voidBenefitPayrollInput({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        inputId: body.inputId,
        reason: body.reason,
      });
      return NextResponse.json({ input });
    }
    const inputs = await generateBenefitPayrollInputs({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      coverageMonth: body.coverageMonth,
    });
    return NextResponse.json({ inputs });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
