import { add, cmp, neg } from "@openbooks/engine/src/money/money.ts";
import { evaluateAnalyticsRatio } from "./analytics-ratio";

export function exactProfit(revenue: string, costs: string): string {
  return add(revenue, neg(costs));
}

/**
 * Margin is undefined without revenue: null, never a 0% that would tier a
 * costed-but-unbilled customer as "marginal". Callers treat a null margin
 * with negative profit as a loss.
 */
export function exactMarginPercent(profit: string, revenue: string): number | null {
  if (cmp(revenue, "0") <= 0) return null;
  const value = evaluateAnalyticsRatio(profit, revenue, "percent", 18);
  if (value === null) throw new Error("CUSTOMER_MARGIN_RATIO_UNDEFINED");
  return Number(value);
}
