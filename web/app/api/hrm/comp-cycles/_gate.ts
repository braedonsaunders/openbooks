import { NextResponse } from "next/server";
import {
  CompensationError,
  MERIT_CYCLES_NEED_PAYROLL,
} from "@openbooks/engine/src/hrm/compensation/errors.ts";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";
import { compensationErrorResponse } from "../compensation/_lib";

/**
 * Merit cycles ride Compensation and additionally need Payroll: a round
 * reads current pay and pushes new rates through it. Payroll off refuses by
 * name so the operator knows what to turn on; the engine rechecks Payroll
 * wherever a round reads pay or pushes rates.
 */
export async function meritCyclesPayrollRefusal(orgId: string): Promise<NextResponse | null> {
  if (await isFeatureEnabled(orgId, "payroll")) return null;
  return compensationErrorResponse(new CompensationError("REFUSED", MERIT_CYCLES_NEED_PAYROLL));
}

/**
 * The full merit-cycle gate for handlers that resolve their own
 * permission: Compensation off reads as not-found, then the Payroll
 * refusal above.
 */
export async function meritCycleGate(orgId: string): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(orgId, "hrmCompensation"))) return notFound("record");
  return meritCyclesPayrollRefusal(orgId);
}
