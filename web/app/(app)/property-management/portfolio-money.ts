import { decimalSum } from "../../../lib/statement-format";
import type { Money } from "./types";

/** Exact portfolio totals remain grouped by currency; currencies are never added together. */
export function sumByCurrency(
  entries: ReadonlyArray<{ currency: string; amount: string }>,
): Array<{ currency: string; total: string }> {
  const amounts = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.currency.trim()) {
      throw new Error("A currency is required to total property management amounts.");
    }
    const list = amounts.get(entry.currency);
    if (list) list.push(entry.amount);
    else amounts.set(entry.currency, [entry.amount]);
  }
  return [...amounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, values]) => ({ currency, total: decimalSum(values) }));
}

export function formatGroupedMoney(
  parts: ReadonlyArray<{ currency: string; total: string }>,
  money: Money,
): string {
  return parts.map((part) => money(part.total, { currency: part.currency })).join(" · ");
}
