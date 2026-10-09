import { fromUnits, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";

export interface VendorRetainageSource {
  documentId: string;
  held: string;
}
export interface VendorRetainageReservation extends VendorRetainageSource {
  previousAmount: string;
  amount: string;
}

/** Reserve the oldest posted draws first; each release keeps its own source coordinates. */
export function reserveVendorRetainageSources(
  sources: readonly VendorRetainageSource[], previouslyReleased: string, releaseAmount: string,
): VendorRetainageReservation[] {
  const exact = (value: string): bigint => {
    const parsed = canonicalDecimal(value, 4);
    if (parsed === null || toUnits(parsed) < 0n) throw new Error("Retainage source amounts must be exact nonnegative decimals");
    return toUnits(parsed);
  };
  let skipped = exact(previouslyReleased), remaining = exact(releaseAmount);
  const reservations: VendorRetainageReservation[] = [];
  for (const source of sources) {
    const held = exact(source.held);
    const previous = skipped > held ? held : skipped;
    skipped -= previous;
    const capacity = held - previous;
    const amount = remaining > capacity ? capacity : remaining;
    if (amount > 0n) reservations.push({ ...source, held: fromUnits(held), previousAmount: fromUnits(previous), amount: fromUnits(amount) });
    remaining -= amount;
  }
  if (skipped !== 0n || remaining !== 0n) throw new Error("Retainage release cannot be matched to its posted source bills");
  return reservations;
}
