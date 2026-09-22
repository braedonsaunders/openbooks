import { add, cmp, mulPercent, normalizeMoney } from "../money/money.ts";

export interface QuantityPriceBreak {
  minimumQuantity: string;
  unitPrice: string;
}

/** Select the all-units price for a quantity. Thresholds must be unique and
 * positive; the greatest threshold not exceeding quantity wins. */
export function selectQuantityPrice(
  quantity: string,
  breaks: readonly QuantityPriceBreak[],
): QuantityPriceBreak | null {
  if (cmp(quantity, "0") <= 0) throw new Error("Pricing quantity must be greater than zero");
  const ordered = [...breaks].sort((a, b) => cmp(a.minimumQuantity, b.minimumQuantity));
  let prior: QuantityPriceBreak | null = null;
  for (const entry of ordered) {
    if (cmp(entry.minimumQuantity, "0") <= 0) throw new Error("Price break quantities must be greater than zero");
    if (cmp(entry.unitPrice, "0") < 0) throw new Error("Price break unit prices cannot be negative");
    if (prior && cmp(prior.minimumQuantity, entry.minimumQuantity) === 0) {
      throw new Error("Price break quantities must be unique");
    }
    if (cmp(entry.minimumQuantity, quantity) <= 0) prior = entry;
  }
  return prior ? { minimumQuantity: prior.minimumQuantity, unitPrice: normalizeMoney(prior.unitPrice) } : null;
}

export type PriceLevelFormula =
  | { method: "explicit" }
  | { method: "markup_discount"; percentage: string }
  | { method: "cost_plus"; percentage: string };

/** Generate an auditable matrix value from another price or cost basis. The
 * generated value is persisted in the schedule; transactions never reprice
 * historical lines from a later-changing cost. */
export function deriveMatrixPrice(basis: string, formula: PriceLevelFormula): string {
  const canonicalBasis = normalizeMoney(basis);
  if (cmp(canonicalBasis, "0") < 0) throw new Error("Pricing basis cannot be negative");
  if (formula.method === "explicit") return canonicalBasis;
  const adjustment = mulPercent(canonicalBasis, formula.percentage);
  const result = add(canonicalBasis, adjustment);
  if (cmp(result, "0") < 0) throw new Error("Derived selling price cannot be negative");
  return result;
}
