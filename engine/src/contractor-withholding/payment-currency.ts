import { canonicalDecimal, fixedDecimal } from "../money/exact-decimal.ts";
import { fromUnits, mulRate, roundDiv, toUnits } from "../money/money.ts";

/** Exact transaction-to-statutory rate; never infer par for an uncovered pair. */
export function withholdingCurrencyRate(rate: unknown): string {
  const exact = canonicalDecimal(rate, 10);
  if (exact === null || BigInt(exact.replace(".", "")) <= 0n) throw new Error("withholding reporting exchange rate must be an explicit positive decimal");
  return fixedDecimal(exact, 10);
}

export function withholdingStatutoryAmount(amount: string, rate: string): string {
  return mulRate(amount, withholdingCurrencyRate(rate));
}

/** Convert statutory liabilities back into cash at the same frozen quote, rounding once. */
export function withholdingTransactionAmount(amount: string, rate: string, decimalPlaces = 4): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) throw new Error("invalid withholding currency precision");
  const rateUnits = BigInt(withholdingCurrencyRate(rate).replace(".", ""));
  const quantum = 10n ** BigInt(4 - decimalPlaces);
  return fromUnits(roundDiv(toUnits(amount) * 10_000_000_000n, rateUnits * quantum) * quantum);
}
