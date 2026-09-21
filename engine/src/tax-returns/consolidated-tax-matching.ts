/**
 * 26 CFR 1.1502-13(c)(2)(ii): the seller takes its intercompany item into
 * account as the difference between actual and recomputed corresponding
 * items. Amounts here are signed income effects: a deduction is negative.
 *
 * Source: 1.1502-13(c)(4) and (c)(7)(ii)(D), Example 4.
 * https://www.govinfo.gov/content/pkg/CFR-2025-title26-vol14/pdf/CFR-2025-title26-vol14-sec1-1502-13.pdf
 *
 * The caller supplies the statutory schedules and redetermined attributes.
 * This arithmetic does not infer group membership, recapture, elections,
 * recognition, or a tax calendar from book records. In particular, the
 * Example 4 fixture's disregard of the half-year convention is not a rule
 * for production depreciation schedules.
 */
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { fromUnits, toUnits } from "../money/money.ts";

export class ConsolidatedTaxMatchingError extends Error {
  readonly name = "ConsolidatedTaxMatchingError";
}

/** Attribute keys are supplied by the tax policy, after the redetermination
 * required by (c)(1)/(c)(4); they are not guessed from an amount's sign. */
export type ConsolidatedCorrespondingItem = Readonly<{
  attribute: string;
  amount: string;
}>;

export type ConsolidatedTaxMatchingInput = Readonly<{
  deferredOpening: string;
  actualCorrespondingItems: readonly ConsolidatedCorrespondingItem[];
  recomputedCorrespondingItems: readonly ConsolidatedCorrespondingItem[];
}>;

export type ConsolidatedTaxMatchingResult = {
  deferredOpening: string;
  actualCorrespondingAmount: string;
  recomputedCorrespondingAmount: string;
  sellerMatchingAmount: string;
  sellerMatchingItems: ConsolidatedCorrespondingItem[];
  deferredClosing: string;
};

function exactAmount(value: unknown, name: string): bigint {
  const exact = typeof value === "string" ? canonicalDecimal(value, 4) : null;
  if (exact === null) {
    throw new ConsolidatedTaxMatchingError(
      `${name} must be an exact decimal string with at most four decimal places; supply the calculated statutory amount without rounding or numeric coercion`,
    );
  }
  return toUnits(exact);
}

function collectItems(
  items: readonly ConsolidatedCorrespondingItem[],
  name: string,
): Map<string, bigint> {
  if (!Array.isArray(items)) {
    throw new ConsolidatedTaxMatchingError(
      `${name} must be an explicit list of calculated corresponding items; supply an empty list only when no items were taken into account`,
    );
  }
  const amounts = new Map<string, bigint>();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item.attribute !== "string" || !item.attribute.trim()
      || item.attribute !== item.attribute.trim()) {
      throw new ConsolidatedTaxMatchingError(
        `${name}[${index}] must identify its redetermined tax attribute; resolve the statutory character before matching`,
      );
    }
    const amount = exactAmount(item.amount, `${name}[${index}].amount`);
    // Several vintages can contribute to the same attribute. Aggregate their
    // exact amounts; list order must not change a matched tax result.
    amounts.set(item.attribute, (amounts.get(item.attribute) ?? 0n) + amount);
  }
  return amounts;
}

/** Match one period/event against its previously frozen deferred balance.
 *
 * Each attribute satisfies actual + seller = recomputed, and the deferred
 * amount satisfies opening = seller + closing. The signed differences are
 * preserved, including losses. No cap, absolute value or zero clamp conceals
 * inconsistent caller schedules; the policy/consumer must reconcile this
 * result to the approved intercompany item and its prior recognition.
 */
export function matchConsolidatedTaxItems(
  input: ConsolidatedTaxMatchingInput,
): ConsolidatedTaxMatchingResult {
  const opening = exactAmount(input.deferredOpening, "deferredOpening");
  const actual = collectItems(input.actualCorrespondingItems, "actualCorrespondingItems");
  const recomputed = collectItems(input.recomputedCorrespondingItems, "recomputedCorrespondingItems");
  const attributes = [...new Set([...actual.keys(), ...recomputed.keys()])].sort();
  const sellerMatchingItems: ConsolidatedCorrespondingItem[] = [];
  let actualTotal = 0n;
  let recomputedTotal = 0n;
  let sellerTotal = 0n;
  for (const attribute of attributes) {
    // An absent attribute in an explicitly supplied item list has no amount.
    // The whole list may never be omitted and silently interpreted as zero.
    const actualAmount = actual.get(attribute) ?? 0n;
    const recomputedAmount = recomputed.get(attribute) ?? 0n;
    const sellerAmount = recomputedAmount - actualAmount;
    actualTotal += actualAmount;
    recomputedTotal += recomputedAmount;
    sellerTotal += sellerAmount;
    if (sellerAmount !== 0n) {
      sellerMatchingItems.push({ attribute, amount: fromUnits(sellerAmount) });
    }
  }
  return {
    deferredOpening: fromUnits(opening),
    actualCorrespondingAmount: fromUnits(actualTotal),
    recomputedCorrespondingAmount: fromUnits(recomputedTotal),
    sellerMatchingAmount: fromUnits(sellerTotal),
    sellerMatchingItems,
    deferredClosing: fromUnits(opening - sellerTotal),
  };
}

/** Depreciation offsets have ordinary attributes under (c)(4)(i).
 * Both deduction inputs are positive magnitudes from the two tax schedules;
 * they are converted to signed corresponding items exactly once here. */
export function matchConsolidatedDepreciation(input: Readonly<{
  deferredOpening: string;
  actualDeduction: string;
  recomputedDeduction: string;
}>): ConsolidatedTaxMatchingResult {
  const actual = exactAmount(input.actualDeduction, "actualDeduction");
  const recomputed = exactAmount(input.recomputedDeduction, "recomputedDeduction");
  if (actual < 0n || recomputed < 0n) {
    throw new ConsolidatedTaxMatchingError(
      "depreciation deductions must be nonnegative magnitudes from the actual and recomputed schedules; use signed corresponding items for a recapture or other income event",
    );
  }
  return matchConsolidatedTaxItems({
    deferredOpening: input.deferredOpening,
    actualCorrespondingItems: [{ attribute: "ordinary", amount: fromUnits(-actual) }],
    recomputedCorrespondingItems: [{ attribute: "ordinary", amount: fromUnits(-recomputed) }],
  });
}
