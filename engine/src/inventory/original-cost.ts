import { fromUnits, roundDiv, toUnits } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";

/**
 * Locator naming the layer an original-cost refusal belongs to. Pure
 * allocation math has no identity of its own — callers pass what they
 * know so the refusal names the remedy's target instead of escaping as
 * an anonymous 500 through the route catch-alls.
 */
export interface OriginalCostLocation {
  itemId?: string;
  stockLocationId?: string;
  layerId?: string;
}

/** Unknown legacy provenance propagates; an anchor receipt is not pool cost. */
export function sumOriginalCosts(values: (string | null)[]): string | null {
  return values.some((value) => value == null)
    ? null : fromUnits(values.reduce((sum, value) => sum + toUnits(value!), 0n));
}

/**
 * Relieve weighted original basis; retained balance owns the exact residual.
 *
 * A take outside [0, available] names an inconsistent layer — every caller
 * clamps its take by construction, so reaching here means stored state no
 * longer adds up. Refuse by name (InventoryError → 422) with the layer
 * identified and the only safe remedy, never a bare Error (500).
 */
export function consumeOriginalCost(
  basis: string | null,
  quantity: string,
  available: string,
  location?: OriginalCostLocation,
): string | null {
  if (basis == null) return null;
  const total = toUnits(available);
  const take = toUnits(quantity);
  if (total <= 0n || take < 0n || take > total) throw originalCostRefusal(quantity, available, location);
  return fromUnits(roundDiv(toUnits(basis) * take, total));
}

function originalCostRefusal(quantity: string, available: string, location?: OriginalCostLocation): InventoryError {
  const scope = [
    location?.itemId ? `item ${location.itemId}` : null,
    location?.stockLocationId ? `location ${location.stockLocationId}` : null,
    location?.layerId ? `layer ${location.layerId}` : null,
  ].filter((part): part is string => part !== null).join(", ");
  return new InventoryError(
    `original-cost allocation takes ${quantity} from ${available} available` +
      (scope ? ` (${scope})` : "") +
      ` — the cost layer's remaining basis is inconsistent; ` +
      `reverse the corrupting movement through a controlled reversal instead of editing the layer`,
  );
}

/** Allocate a known balance to exact carrying fragments, preserving every tick. */
export function splitOriginalCost(
  basis: string | null,
  quantities: string[],
  carryingValues?: string[],
  location?: OriginalCostLocation,
): (string | null)[] {
  let remaining = basis;
  let quantity = quantities.reduce((sum, value) => sum + toUnits(value), 0n);
  const shares = quantities.map((value) => {
    const share = consumeOriginalCost(remaining, value, fromUnits(quantity), location);
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
