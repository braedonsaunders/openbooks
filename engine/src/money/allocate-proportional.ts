import { canonicalDecimal } from "./exact-decimal.ts";
import { fromUnits, roundDiv, toUnits } from "./money.ts";

export type MoneyAllocationPart = Readonly<{ key: string; amount: string }>;
export type MoneyAllocationSplit = Readonly<{
  key: string;
  take: string;
  keep: string;
}>;

function nonnegativeUnits(value: unknown, name: string): bigint {
  const canonical = typeof value === "string" ? canonicalDecimal(value, 4) : null;
  if (canonical === null) {
    throw new Error(`${name} must be an exact decimal string with at most four decimal places`);
  }
  const units = toUnits(canonical);
  if (units < 0n) throw new Error(`${name} must not be negative`);
  return units;
}

function validateAllocation(
  parts: readonly MoneyAllocationPart[],
  takeTotal: string,
) {
  if (!Array.isArray(parts)) throw new Error("money allocation requires an explicit component list");
  const take = nonnegativeUnits(takeTotal, "allocation total");
  const keys = new Set<string>();
  const rows = parts.map((part, index) => {
    if (!part || typeof part.key !== "string" || !part.key.trim() || part.key !== part.key.trim()) {
      throw new Error(`allocation component ${index} requires a stable nonempty key`);
    }
    if (keys.has(part.key)) throw new Error(`allocation component ${part.key} is declared more than once`);
    keys.add(part.key);
    return { key: part.key, amount: nonnegativeUnits(part.amount, `allocation component ${part.key}`) };
  });
  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  if (take > total) throw new Error("allocation total exceeds the sum of its approved components");
  return { take, rows, total };
}

/** Split an approved nonnegative component vector at ledger precision.
 *
 * Independent rounded products need not sum to takeTotal. Instead, floor
 * each exact proportional share, then assign the remaining 0.0001 units
 * by largest fractional remainder (ties use the stable component key).
 * Each retained amount is its original less its allocated amount, so both
 * the component balances and the two aggregate balances remain exact.
 *
 * This function does not select statutory basis, an allocation fraction or
 * component treatment. Its caller supplies those already validated facts.
 */
export function splitMoneyProportionally(
  parts: readonly MoneyAllocationPart[],
  takeTotal: string,
): MoneyAllocationSplit[] {
  const validated = validateAllocation(parts, takeTotal);
  const { take, total } = validated;
  const rows = validated.rows.map((row) => ({ ...row, take: 0n, remainder: 0n }));
  let unitsLeft = take;
  if (total > 0n) {
    for (const row of rows) {
      const product = row.amount * take;
      row.take = product / total;
      row.remainder = product % total;
      unitsLeft -= row.take;
    }
    const ranked = [...rows].sort((left, right) => {
      if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    });
    for (const row of ranked) {
      if (unitsLeft === 0n) break;
      row.take += 1n;
      unitsLeft -= 1n;
    }
  }
  if (unitsLeft !== 0n) throw new Error("money allocation could not conserve its requested total");
  return rows.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    .map((row) => ({ key: row.key, take: fromUnits(row.take), keep: fromUnits(row.amount - row.take) }));
}

/** Allocate a cumulative amount over one frozen component vector.
 *
 * Increasing a cumulative total must never take a unit back from a component:
 * otherwise subtracting two cutoffs creates a negative period deduction.
 * Largest-remainder allocation does not have that property for three or more
 * components, so reporting cutoffs use this separate policy.
 *
 * In fixed lexical key order, round each component's share of the remaining
 * total against the remaining approved weights. Each two-way split is
 * monotone: increasing its input by one unit increases either the component
 * or its remainder by one unit. Induction gives nonnegative differences for
 * every component at any pair of ordered cutoffs. The final remainder is
 * exact, and the full cumulative total recovers every original component.
 *
 * The approved vector and keys must stay fixed between cutoffs. Runtime is
 * bounded by component count, not by the number of monetary units.
 */
export function cumulativeMoneyAllocation(
  parts: readonly MoneyAllocationPart[],
  takeTotal: string,
): MoneyAllocationSplit[] {
  const { take, total, rows } = validateAllocation(parts, takeTotal);
  rows.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  let remainingTake = take;
  let remainingWeight = total;
  const result = rows.map((row) => {
    const allocated = remainingWeight === 0n
      ? 0n
      : roundDiv(remainingTake * row.amount, remainingWeight);
    remainingTake -= allocated;
    remainingWeight -= row.amount;
    return { key: row.key, take: fromUnits(allocated), keep: fromUnits(row.amount - allocated) };
  });
  if (remainingTake !== 0n) throw new Error("cumulative money allocation could not conserve its requested total");
  return result;
}
