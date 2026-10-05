import { add, cmp, neg } from "@openbooks/engine/money";
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

/**
 * The ONE at-risk ordering, shared by the dashboard's churn table and the
 * home dashboard's list: highest churn score first, score ties broken by
 * trailing revenue (exact), revenue ties by name. Two surfaces sorting two
 * ways would show the same customers in different orders — ties are common,
 * so the comparator lives in this client-safe pure module, next to the
 * other customer math both sides may import.
 */
export function compareAtRiskCustomers(
  a: { churnScore: number; revenue: string; name: string },
  b: { churnScore: number; revenue: string; name: string },
): number {
  return b.churnScore - a.churnScore || cmp(b.revenue, a.revenue) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
