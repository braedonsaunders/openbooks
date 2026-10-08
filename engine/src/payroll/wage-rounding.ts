import { add, cmp, mulDecimal, neg, roundMoney } from "../money/money.ts";
import { type PayrollWageRounding, requirePayrollWageRounding } from "../projects/payroll-wage-rounding.ts";
import { allocateProportionally } from "./run-allocation.ts";

/** Price one dimension group while retaining worked dates and exact hours. */
export function priceDatedWageEntries(
  hourlyWage: string, multiplier: string,
  entries: readonly { workedOn: string; hours: string }[],
  terms: PayrollWageRounding,
): { rate: string; days: { workedOn: string; hours: string; amount: string }[] } {
  requirePayrollWageRounding(terms.payrollRateScale, terms.payrollAmountRounding);
  const rate = roundMoney(mulDecimal(hourlyWage, multiplier), terms.payrollRateScale);
  const days = new Map<string, { hours: string; amount: string }>();
  let hours = "0";
  for (const entry of entries) {
    hours = add(hours, entry.hours);
    const day = days.get(entry.workedOn) ?? { hours: "0", amount: "0" };
    day.hours = add(day.hours, entry.hours);
    if (terms.payrollAmountRounding === "time_entry") {
      day.amount = add(day.amount, roundMoney(mulDecimal(rate, entry.hours), 2));
    }
    days.set(entry.workedOn, day);
  }
  if (terms.payrollAmountRounding === "dimension_group") {
    // Allocate the already-rounded group total, preserving existing pay and
    // dated lookback evidence without introducing another rounding boundary.
    const parts = allocateProportionally(roundMoney(mulDecimal(rate, hours), 2),
      [...days].map(([workedOn, day]) => ({ target: workedOn,
        weight: cmp(day.hours, "0") < 0 ? neg(day.hours) : day.hours })));
    return { rate, days: parts.map((part) => ({ workedOn: part.target,
      hours: days.get(part.target)!.hours, amount: part.amount })) };
  }
  return { rate, days: [...days].map(([workedOn, day]) => ({ workedOn, ...day })) };
}
