import { add, cmp, neg } from "@openbooks/engine/src/money/money.ts";
import { evaluateAnalyticsRatio } from "./analytics-ratio";

export function exactProfit(revenue: string, costs: string): string {
  return add(revenue, neg(costs));
}

/** A display/scoring ratio derived only after the money operands are exact. */
export function exactMarginPercent(profit: string, revenue: string): number {
  if (cmp(revenue, "0") <= 0) return 0;
  const value = evaluateAnalyticsRatio(profit, revenue, "percent", 18);
  if (value === null) throw new Error("Customer margin is undefined for positive revenue.");
  return Number(value);
}
