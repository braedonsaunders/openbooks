import { add, cmp, neg } from "../money/money.ts";

export type ProcessBalanceDifferenceKind = "balanced" | "measured_loss" | "unreconciled";

/** One inventory base-unit group of a work order's live recorded movements. */
export type ProcessBalanceSource = {
  unit: string;
  /** Consumed components in this unit. */
  inputQuantity: string;
  /** Every recorded good and secondary output in this unit. */
  outputQuantity: string;
  /** The part of outputQuantity received as the work order's produced item. */
  producedOutputQuantity: string;
};

export type ProcessBalanceRow = ProcessBalanceSource & {
  id: string;
  /** Measured final output in this unit, or null when no operation recorded one. */
  measuredOutputQuantity: string | null;
  /** Input minus accounted output. */
  difference: string;
  differenceKind: ProcessBalanceDifferenceKind;
};

function nonNegative(value: string): string {
  return cmp(value, "0") < 0 ? "0" : value;
}

/**
 * The read model of a process run's material balance, per base unit. Accounted
 * output is the recorded output plus the measured output of the produced item
 * that has not been received yet, so a measured roast weight counts before its
 * receipt and never double counts after it. The difference is input minus
 * accounted output: a positive difference with a measured output is the
 * measured loss (shrink); any other nonzero difference is unreconciled. Posted
 * inventory and ledger entries are read, never changed.
 */
export function processBalanceRows(
  sources: readonly ProcessBalanceSource[],
  measuredByUnit: ReadonlyMap<string, string>,
): ProcessBalanceRow[] {
  const units = [
    ...new Set([...sources.map((source) => source.unit), ...measuredByUnit.keys()]),
  ].sort();
  return units.map((unit) => {
    const source = sources.find((candidate) => candidate.unit === unit) ?? {
      unit,
      inputQuantity: "0",
      outputQuantity: "0",
      producedOutputQuantity: "0",
    };
    const measured = measuredByUnit.get(unit) ?? null;
    const unreceived =
      measured === null ? "0" : nonNegative(add(measured, neg(source.producedOutputQuantity)));
    const accounted = add(source.outputQuantity, unreceived);
    const difference = add(source.inputQuantity, neg(accounted));
    const sign = cmp(difference, "0");
    const differenceKind: ProcessBalanceDifferenceKind =
      sign === 0 ? "balanced" : measured !== null && sign > 0 ? "measured_loss" : "unreconciled";
    return {
      id: unit,
      unit,
      inputQuantity: source.inputQuantity,
      outputQuantity: source.outputQuantity,
      producedOutputQuantity: source.producedOutputQuantity,
      measuredOutputQuantity: measured,
      difference,
      differenceKind,
    };
  });
}
