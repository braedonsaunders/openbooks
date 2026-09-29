import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  generateBenefitPayrollInputs,
  voidBenefitPayrollInput,
} from "@openbooks/engine/src/hrm/benefits/benefits-payroll.ts";
import { benefitsErrorResponse } from "../_lib";
import { benefitPayrollInputsBody } from "./bodies";
/**
 * Benefit pay-run inputs: generate rows for a coverage month, or void one
 * with a reason. Manage grant; HR owns generation, payroll owns the run.
 */
export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: benefitPayrollInputsBody,
  invalidBodyStatus: 400,
  handler: async ({ request: _req, authz: gate, body }) => {
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
  },
});
