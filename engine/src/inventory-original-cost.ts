import { fromUnits, roundDiv, toUnits } from "./money.ts";

/** Unknown legacy provenance propagates; an anchor receipt is not pool cost. */
export function sumOriginalCosts(values: (string | null)[]): string | null {
  return values.some((value) => value == null)
    ? null : fromUnits(values.reduce((sum, value) => sum + toUnits(value!), 0n));
}

/** Relieve weighted original basis; retained balance owns the exact residual. */
export function consumeOriginalCost(basis: string | null, quantity: string, available: string): string | null {
  if (basis == null) return null;
  const total = toUnits(available);
  const take = toUnits(quantity);
  if (total <= 0n || take < 0n || take > total) throw new Error("invalid original-cost quantity allocation");
  return fromUnits(roundDiv(toUnits(basis) * take, total));
}

/** Allocate a known balance to exact carrying fragments, preserving every tick. */
export function splitOriginalCost(basis: string | null, quantities: string[], carryingValues?: string[]): (string | null)[] {
  let remaining = basis;
  let quantity = quantities.reduce((sum, value) => sum + toUnits(value), 0n);
  const shares = quantities.map((value) => {
    const share = consumeOriginalCost(remaining, value, fromUnits(quantity));
    if (remaining != null && share != null) remaining = fromUnits(toUnits(remaining) - toUnits(share));
    quantity -= toUnits(value);
    return share;
  });
  // Quantity rounding may put one fragment below carrying value even when
  // the entire pool remains below original cost. Move only the necessary
  // basis between those representational fragments, conserving the total.
  if (basis != null && carryingValues && toUnits(basis) >= carryingValues.reduce((sum, value) => sum + toUnits(value), 0n)) {
    const values = carryingValues.map(toUnits);
    const units = shares.map((share) => toUnits(share!));
    for (let i = 0; i < units.length; i++) {
      let deficit = values[i]! - units[i]!;
      for (let j = 0; deficit > 0n && j < units.length; j++) {
        const surplus = units[j]! - values[j]!;
        if (surplus <= 0n) continue;
        const take = deficit < surplus ? deficit : surplus;
        units[i]! += take;
        units[j]! -= take;
        deficit -= take;
      }
    }
    return units.map(fromUnits);
  }
  return shares;
}
