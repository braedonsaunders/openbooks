import { toUnits } from "../money/money.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { JournalInstructionError } from "./journal-instruction-error.ts";
export { JournalInstructionError } from "./journal-instruction-error.ts";

export interface JournalInstructionLine {
  line_number: number;
  type: string;
  amount: string;
  quantity: string;
  unit: string | null;
  journal_currency: string | null;
  journal_fx_rate: string | null;
  journal_eliminate: boolean;
  template: string | null;
}

/** Save, import preview and posting share non-monetary and instruction compatibility refusals. */
export function validateJournalInstructionLines(
  mode: string,
  reverseOn: string | null,
  lines: readonly JournalInstructionLine[],
  allowZeroMonetaryLines = false,
): void {
  for (const line of lines) {
    if (mode === "statistical") {
      const quantity = canonicalDecimal(canonicalDecimal(line.quantity, 8), 4);
      if (
        line.type !== "statistical" ||
        toUnits(line.amount) !== 0n ||
        quantity === null ||
        toUnits(quantity) === 0n ||
        !line.unit?.trim()
      ) {
        throw new JournalInstructionError(
          `Line ${line.line_number}: statistical journals require a statistical account, zero money and a nonzero exact quantity with a unit.`,
          "Choose the statistical account and enter its quantity and unit.",
        );
      }
      if (line.template || line.journal_currency || line.journal_eliminate)
        throw new JournalInstructionError(
          `Line ${line.line_number}: a statistical measurement cannot also defer expense, translate currency or eliminate monetary balances.`,
          "Clear those financial instructions from the statistical line.",
        );
    } else if (
      line.type === "statistical" ||
      (toUnits(line.amount) === 0n &&
        !(
          allowZeroMonetaryLines &&
          mode === "monetary" &&
          !line.template &&
          !line.journal_currency &&
          !line.journal_fx_rate &&
          !line.journal_eliminate
        ))
    ) {
      throw new JournalInstructionError(
        `Line ${line.line_number}: monetary journals require a monetary account and a nonzero amount.`,
        "Choose Monetary journal or a Statistical journal with quantity and unit.",
      );
    }
    if (
      line.journal_fx_rate &&
      (canonicalDecimal(line.journal_fx_rate, 10) === null ||
        compareDecimal(line.journal_fx_rate, "0")! <= 0)
    ) {
      throw new JournalInstructionError(
        `Line ${line.line_number}: the exchange rate is invalid.`,
        "Enter a positive exact decimal rate.",
      );
    }
    if (reverseOn && line.template)
      throw new JournalInstructionError(
        "An expense-deferring journal cannot also schedule a full automatic reversal.",
        "Use the amortization schedule's governed cancellation or the native journal void workflow.",
      );
  }
}
