import { add, cmp, neg } from "@openbooks/engine/src/money/money.ts";
import { divideDecimal } from "../exact-decimal";

export function exactProfit(revenue: string, costs: string): string {
  return add(revenue, neg(costs));
}

/** A display/scoring ratio derived only after the money operands are exact. */
export function exactMarginPercent(profit: string, revenue: string): number {
  return cmp(revenue, "0") > 0
    ? Number(divideDecimal(profit, revenue, 18)) * 100
    : 0;
}
