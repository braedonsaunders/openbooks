export const PAYROLL_AMOUNT_ROUNDING = ["dimension_group", "time_entry"] as const;
export type PayrollAmountRounding = typeof PAYROLL_AMOUNT_ROUNDING[number];

export interface PayrollWageRounding {
  readonly payrollRateScale: number;
  readonly payrollAmountRounding: PayrollAmountRounding;
}

/** Wage rounding terms share the wage's effective date and audit history. */
export function requirePayrollWageRounding(rateScale: unknown, amountRounding: unknown): PayrollWageRounding {
  if (typeof rateScale !== "number" || !Number.isInteger(rateScale) || rateScale < 0 || rateScale > 4) {
    throw new Error("Payroll wage rate precision must be an integer from 0 through 4; select the multiplied hourly rate precision on the dated wage record.");
  }
  if (amountRounding !== "dimension_group" && amountRounding !== "time_entry") {
    throw new Error("Payroll wage amount rounding must be dimension_group or time_entry; select the rounding scope on the dated wage record.");
  }
  return { payrollRateScale: rateScale, payrollAmountRounding: amountRounding };
}
