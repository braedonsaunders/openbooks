import { fromUnits, roundDiv, toUnits } from "@openbooks/engine/money/money";

/**
 * A total and the parts it is made of, rounded together for compact display
 * so the figures shown side by side add up. The total rounds half up to
 * `significant` significant digits; the parts are rounded to the same
 * quantum and apportioned by largest remainder so they sum to the rounded
 * total. Exact four-place decimal strings in and out, never a float.
 *
 * When the parts do not sum to the total, or any part is negative, nothing
 * can be apportioned honestly: every figure rounds on its own.
 */
export function additiveRounding(
  total: string,
  parts: readonly string[],
  significant = 3,
): { total: string; parts: string[] } {
  const totalUnits = toUnits(total);
  const partUnits = parts.map((part) => toUnits(part));
  const magnitude = (totalUnits < 0n ? -totalUnits : totalUnits).toString().length;
  const quantum = magnitude > significant ? 10n ** BigInt(magnitude - significant) : 1n;
  const round = (units: bigint) => roundDiv(units, quantum) * quantum;
  const sum = partUnits.reduce((acc, units) => acc + units, 0n);
  if (sum !== totalUnits || partUnits.some((units) => units < 0n)) {
    return {
      total: fromUnits(round(totalUnits)),
      parts: partUnits.map((units) => fromUnits(round(units))),
    };
  }
  const roundedTotal = round(totalUnits);
  const floors = partUnits.map((units) => (units / quantum) * quantum);
  let short = (roundedTotal - floors.reduce((acc, units) => acc + units, 0n)) / quantum;
  // Largest remainder first; ties go to the earlier part, so the result is deterministic.
  const order = partUnits
    .map((units, index) => ({ index, remainder: units - floors[index]! }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (short <= 0n) break;
    floors[index] = floors[index]! + quantum;
    short -= 1n;
  }
  return { total: fromUnits(roundedTotal), parts: floors.map((units) => fromUnits(units)) };
}
