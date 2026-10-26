import { add, fromUnits, toUnits } from "../money/money.ts";
import { TaxReturnError } from "./return.ts";

/**
 * Filer-entered adjustments to a return's adjustment lines.
 *
 * An adjustment line is a return box with no ledger source and no formula
 * (GST34 lines 104 and 107, for example). The filer enters the amount as it
 * appears on the form, and each entry carries the reason it is needed, such as
 * pre-conversion activity recorded in a prior system. Several entries may land
 * on one line; the return sums them exactly. The entries themselves are the
 * governed record: a prepared filing keeps every reason and author, and the
 * filed snapshot keeps them immutable.
 */

/** Most adjustment entries one prepared return may carry. */
export const TAX_RETURN_ADJUSTMENT_LIMIT = 100;

/** Longest reason recorded for one adjustment entry. */
export const TAX_RETURN_ADJUSTMENT_REASON_MAX = 500;

/** Decimal amounts with up to four places, matching the return's box precision. */
const ADJUSTMENT_AMOUNT_RE = /^-?\d{1,15}(\.\d{1,4})?$/;

/** One adjustment entry as the filer supplies it, before it is recorded. */
export interface TaxReturnAdjustmentInput {
  /** The adjustment line the amount is entered on, e.g. "104". */
  lineCode: string;
  /** Exact decimal amount as displayed on the return (never sign-flipped). */
  amount: string;
  /** Why the amount is needed; required. */
  reason: string;
}

/**
 * Validate and canonicalize adjustment entries. Pure. Refuses by naming the
 * line and the remedy; never drops an entry silently. Whether a line is an
 * adjustment line of the form is checked by the return computation itself.
 */
export function normalizeTaxReturnAdjustments(
  inputs: readonly TaxReturnAdjustmentInput[],
): TaxReturnAdjustmentInput[] {
  if (!Array.isArray(inputs)) {
    throw new TaxReturnError(
      "return adjustments must be a list of entries with a line, decimal amount and reason",
    );
  }
  if (inputs.length > TAX_RETURN_ADJUSTMENT_LIMIT) {
    throw new TaxReturnError(
      `a return takes at most ${TAX_RETURN_ADJUSTMENT_LIMIT} adjustment entries — combine related amounts into one entry with a single reason`,
    );
  }
  return inputs.map((input, index) => {
    if (
      !input ||
      typeof input.lineCode !== "string" ||
      typeof input.amount !== "string" ||
      typeof input.reason !== "string"
    ) {
      throw new TaxReturnError(
        `adjustment ${index + 1} needs a line, decimal amount as text and reason — complete all three fields before saving`,
      );
    }
    const lineCode = input.lineCode.trim();
    if (!lineCode) {
      throw new TaxReturnError(
        `adjustment ${index + 1} names no return line — choose the adjustment line it belongs to`,
      );
    }
    if (lineCode.length > 20) {
      throw new TaxReturnError(
        `adjustment ${index + 1} names an unsupported return line — choose a line of at most 20 characters`,
      );
    }
    const amount = input.amount.trim();
    if (!ADJUSTMENT_AMOUNT_RE.test(amount)) {
      throw new TaxReturnError(
        `the adjustment on line ${lineCode} is not a decimal amount — enter at most 15 whole-number digits and four decimal places, for example 3018.84 or -50`,
      );
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new TaxReturnError(
        `the adjustment on line ${lineCode} needs a reason — state where the amount comes from, for example "Jan–Aug 2025 pre-conversion activity per prior system"`,
      );
    }
    if (reason.length > TAX_RETURN_ADJUSTMENT_REASON_MAX) {
      throw new TaxReturnError(
        `the reason for the adjustment on line ${lineCode} is longer than ${TAX_RETURN_ADJUSTMENT_REASON_MAX} characters — shorten it and keep the detail in your records`,
      );
    }
    return { lineCode, amount: fromUnits(toUnits(amount)), reason };
  });
}

/**
 * Sum entries into one exact amount per adjustment line — the shape the return
 * computation takes. Pure; uses bigint money arithmetic, never floats.
 */
export function aggregateTaxReturnAdjustments(
  inputs: readonly Pick<TaxReturnAdjustmentInput, "lineCode" | "amount">[],
): Record<string, string> {
  const totals = new Map<string, string>();
  for (const input of inputs) {
    const prior = totals.get(input.lineCode);
    totals.set(input.lineCode, prior === undefined ? input.amount : add(prior, input.amount));
  }
  return Object.fromEntries(totals);
}
