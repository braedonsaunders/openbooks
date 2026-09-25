import { sum } from "../money/money.ts";
import type { Line } from "./run-stub-records.ts";

/**
 * Federally exempt U.S. compensation classes carried to state withholding.
 * Each value is a federal preemption with its statute, cited where the
 * classes are consumed (rail 49 USC 11502, motor 49 USC 14503, air-carrier
 * 49 USC 40116(f), seafarer 46 USC 11108(a), Armed Forces pay under the
 * state provisions that reference it); state-specific service classes live
 * in their state packs, never here.
 *
 * The per-line classification lives on the 0359 one-to-one earning
 * classification record (migration 0407, `statutory_exemption_category`)
 * and is stamped onto every stub earning line; unclassified lines land in
 * the null bucket, which states requiring a classification refuse by name.
 */
export const US_STATUTORY_EXEMPTION_CATEGORIES = [
  "military_pay",
  "rail_carrier",
  "motor_carrier",
  "air_carrier",
  "seafarer",
] as const;

export type UsStatutoryExemptionCategory = (typeof US_STATUTORY_EXEMPTION_CATEGORIES)[number];

export interface UsStatutoryExemptionAmount {
  /** Null is retained so a state that requires classification can refuse it by name. */
  category: UsStatutoryExemptionCategory | null;
  amount: string;
}

/**
 * Aggregate taxable earning lines by statutory exemption class. Unlike
 * supplemental wages, exempt compensation is usually ordinary periodic pay
 * (a rail worker's salary), so there is no non-periodic filter — every
 * taxable earning line lands in exactly one bucket.
 */
export function aggregateUsStatutoryExemptionAmounts(
  lines: readonly Line[],
): UsStatutoryExemptionAmount[] {
  const grouped = new Map<UsStatutoryExemptionCategory | null, string[]>();
  for (const line of lines) {
    if (line.kind !== "earning" || line.accrualOnly || line.taxable === false) continue;
    const category = line.statutoryExemptionCategory ?? null;
    const amounts = grouped.get(category) ?? [];
    amounts.push(line.amount);
    grouped.set(category, amounts);
  }
  return [...grouped.entries()]
    .map(([category, amounts]) => ({ category, amount: sum(amounts) }))
    .sort((a, b) => String(a.category ?? "").localeCompare(String(b.category ?? "")));
}
