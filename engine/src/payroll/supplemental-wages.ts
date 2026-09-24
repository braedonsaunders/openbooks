import { sum } from "../money/money.ts";
import type { Line } from "./run-stub-records.ts";

/** California's separate-supplemental schedule distinguishes these two classes. */
export const US_SUPPLEMENTAL_WAGE_CATEGORIES = [
  "bonus_or_stock_option",
  "other",
] as const;

export type UsSupplementalWageCategory = (typeof US_SUPPLEMENTAL_WAGE_CATEGORIES)[number];

export interface UsSupplementalWageAmount {
  /** Null is retained so a state that requires classification can refuse it by name. */
  category: UsSupplementalWageCategory | null;
  amount: string;
}

/** Aggregate taxable one-off earning lines without guessing an absent category. */
export function aggregateUsSupplementalWageAmounts(
  lines: readonly Line[],
): UsSupplementalWageAmount[] {
  const grouped = new Map<UsSupplementalWageCategory | null, string[]>();
  for (const line of lines) {
    if (line.kind !== "earning" || line.accrualOnly || line.taxable === false || !line.nonPeriodic) continue;
    const category = line.supplementalWageCategory ?? null;
    const amounts = grouped.get(category) ?? [];
    amounts.push(line.amount);
    grouped.set(category, amounts);
  }
  return [...grouped.entries()]
    .map(([category, amounts]) => ({ category, amount: sum(amounts) }))
    .sort((a, b) => String(a.category ?? "").localeCompare(String(b.category ?? "")));
}
