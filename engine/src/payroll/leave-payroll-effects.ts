import { add } from "../money/money.ts";
import { mulMoney, type Money } from "../money/brands.ts";
import { LeavePayrollInputError, type LeavePayrollInput } from "./leave-payroll-inputs.ts";

export interface LeavePayrollPayout {
  readonly absenceDate: string;
  readonly hours: string;
  readonly amount: Money;
}

export interface LeavePayrollBankIn {
  readonly planId: string;
  readonly hours: string;
}

/** Price approved leave exactly and consolidate bank deposits by plan. */
export function priceLeavePayrollInputs(
  inputs: readonly LeavePayrollInput[],
  hourlyWage: string | null,
): { payouts: LeavePayrollPayout[]; bankIns: LeavePayrollBankIn[] } {
  const payouts: LeavePayrollPayout[] = [];
  const bankHours = new Map<string, string>();
  for (const input of inputs) {
    if (input.kind === "payout") {
      if (hourlyWage === null) {
        throw new LeavePayrollInputError(
          "an approved leave payout has no effective wage rate — correct the employee's pay rate before calculating payroll",
        );
      }
      payouts.push({
        absenceDate: input.absenceDate,
        hours: input.hours,
        amount: mulMoney(hourlyWage, input.hours),
      });
      continue;
    }
    if (!input.entitlementPlanId) {
      throw new LeavePayrollInputError(
        "approved banked leave has no effective entitlement mapping — map the leave type to an active accruing hours plan other than Vacation, then recalculate payroll",
      );
    }
    bankHours.set(
      input.entitlementPlanId,
      add(bankHours.get(input.entitlementPlanId) ?? "0", input.hours),
    );
  }
  return {
    payouts,
    bankIns: [...bankHours].map(([planId, hours]) => ({ planId, hours })),
  };
}
