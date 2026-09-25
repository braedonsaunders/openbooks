/** Standalone-selling-price apportionment and fair-value flags. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { fromUnits, toUnits } from "../money/money.ts";
import { canonicalDecimal, fixedDecimal } from "../money/exact-decimal.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";

// ---------------------------------------------------------------------------
// Exact apportionment (integer money units, no drift)
// ---------------------------------------------------------------------------

/**
 * Split `totalUnits` across `weights` so the parts are proportional and sum
 * EXACTLY to the total (largest-remainder / Hamilton apportionment). A zero
 * total or non-positive weight sum yields all zeros.
 */
export function apportion(totalUnits: bigint, weights: readonly (number | string | bigint)[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  const iw = weights.map((weight) => {
    if (typeof weight === "bigint") return weight > 0n ? weight : 0n;
    const units = toUnits(String(weight));
    return units > 0n ? units : 0n;
  });
  const iwsum = iw.reduce((a, b) => a + b, 0n);
  if (iwsum === 0n || totalUnits === 0n) return new Array(n).fill(0n);

  const negative = totalUnits < 0n;
  const total = negative ? -totalUnits : totalUnits;

  const base = iw.map((w) => (total * w) / iwsum);
  const distributed = base.reduce((a, b) => a + b, 0n);
  let remainder = total - distributed;

  // Hand leftover units out by descending fractional part (stable by index).
  const order = iw
    .map((w, i) => ({ i, frac: (total * w) % iwsum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    base[order[k % order.length]!.i]! += 1n;
    remainder -= 1n;
    k++;
  }
  return negative ? base.map((u) => -u) : base;
}

/**
 * Allocate a bundle's transaction price across obligations in proportion to
 * their standalone selling price (relative-SSP method, ASC 606-10-32-31).
 * Returns allocated amounts (decimal strings) that sum EXACTLY to `total`.
 * SSP is per unit; quantities retain the document's eight decimal places.
 * Obligations with no SSP use their already-extended booked amount as weight.
 */
export function allocateByRelativeSSP(
  total: string,
  obligations: { ssp?: string | null; booked?: string | null; quantity?: string | null }[],
): string[] {
  const weights = obligations.map((o) => {
    if (o.ssp != null && o.ssp !== "" && toUnits(o.ssp) < 0n) {
      throw new RevenueRecognitionError("Revenue allocation requires non-negative selling prices");
    }
    // Keep the unrounded product at scale 12, including sub-money-unit SSPs.
    // Rounding each extended SSP first can erase a valid allocation weight.
    const weight = o.ssp != null && o.ssp !== ""
      ? toUnits(o.ssp) * recognitionQuantityUnits(o.quantity ?? "1")
      : toUnits(o.booked ?? "0") * 100_000_000n;
    if (weight < 0n) throw new RevenueRecognitionError("Revenue allocation requires non-negative selling prices and weights");
    return weight;
  });
  const totalUnits = toUnits(total);
  if (totalUnits !== 0n && weights.every((weight) => weight === 0n)) {
    throw new RevenueRecognitionError("Revenue allocation requires a positive selling price weight for a nonzero total");
  }
  return apportion(totalUnits, weights).map(fromUnits);
}

function recognitionQuantityUnits(quantity: string): bigint {
  const value = typeof quantity === "string" ? canonicalDecimal(quantity, 8) : null;
  if (value === null || value.startsWith("-") || value.split(".")[0]!.length > 20) {
    throw new RevenueRecognitionError("Revenue quantity must be a non-negative exact numeric(28,8) decimal");
  }
  return BigInt(fixedDecimal(value, 8).replace(".", ""));
}

/**
 * Fair-value range review (source platform fair-value range policy): compare an
 * obligation's allocated PER-UNIT price against the matched fair value price's
 * [low, high] bounds. Either bound may be absent (open-ended range). Returns
 * null when in range or when no bound is configured. Cross multiplication
 * avoids division and makes exact boundary decisions.
 */
export function fairValueRangeFlag(
  allocated: string,
  quantity: string | null | undefined,
  low: string | null,
  high: string | null,
): "below_range" | "above_range" | null {
  if (low == null && high == null) return null;
  const quantityUnits = recognitionQuantityUnits(quantity ?? "1");
  const qty = quantityUnits > 0n ? quantityUnits : 100_000_000n;
  const amount = toUnits(allocated) * 100_000_000n;
  if (low != null && amount < toUnits(low) * qty) return "below_range";
  if (high != null && amount > toUnits(high) * qty) return "above_range";
  return null;
}
