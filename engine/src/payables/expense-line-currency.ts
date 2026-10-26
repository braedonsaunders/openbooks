import { add, cmp, mulDecimalFactors, neg, toUnits } from "../money/money.ts";
import { canonicalDecimal, divideDecimal } from "../money/exact-decimal.ts";
import {
  CurrencyError,
  isIso4217CurrencyCode,
  SUPPORTED_CURRENCIES,
  updateFxRate,
} from "../fx/currencies.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";

/**
 * Expense lines spent in another currency than their report.
 *
 * The receipt states an amount in its own currency; the report reimburses
 * and posts in the report currency. The line keeps both: the original
 * currency and amounts as spent, and the converted amounts that total and
 * post. The conversion rate comes from exactly one source, recorded as the
 * line's evidence:
 *
 * - `rate_table`: the organization's dated exchange rate for the expense
 *   date (the entity's posting rate type), with the observation it read;
 * - `override`: an operator rate with its reason, where the organization's
 *   expense FX policy allows one;
 * - `billed_amount`: the amount a card statement billed in the report
 *   currency. That amount is the line's converted gross exactly and the
 *   effective rate is derived from it.
 *
 * Converted amounts round once, half away from zero, to the report
 * currency's minor units. Pure arithmetic here is shared by the drawer's
 * preview and the server's authoritative conversion.
 */

export const EXPENSE_FX_METHODS = ["rate_table", "override", "billed_amount"] as const;
export type ExpenseFxMethod = (typeof EXPENSE_FX_METHODS)[number];

export function isExpenseFxMethod(value: unknown): value is ExpenseFxMethod {
  return typeof value === "string" && (EXPENSE_FX_METHODS as readonly string[]).includes(value);
}

/** What the operator states about a foreign-currency line. */
export type ExpenseLineForeignInput = {
  currency: string;
  /** The line amount in its original currency, before tax. */
  amount: string;
  /** The tax shown on the receipt in its original currency, when the line states one. */
  taxAmount: string | null;
  /** The expense date whose rate converts the line. */
  rateDate: string;
  method: ExpenseFxMethod;
  /**
   * `override`: the operator's rate. `rate_table`: the rate the operator was
   * shown, so a rate that changed before the save refuses instead of
   * silently converting at another figure.
   */
  rate: string | null;
  /** `override`: why the dated rate does not apply. */
  reason: string | null;
  /** `billed_amount`: the gross amount billed in the report currency. */
  billedAmount: string | null;
};

/** The stored evidence for one conversion (document_lines.original_fx_evidence). */
export type ExpenseLineFxEvidence = {
  version: 1;
  method: ExpenseFxMethod;
  rate: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: string;
  /** Where the rate came from: the exchange-rate row's source, `operator`, or `billed_amount`. */
  source: string;
  reason: string | null;
  rateType: string | null;
  observationId: string | null;
  observationDate: string | null;
  digest: string | null;
  billedAmount: string | null;
};

export class ExpenseFxInputError extends Error {
  readonly name = "ExpenseFxInputError";
  readonly status = 422;
  constructor(
    message: string,
    readonly code: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

/** The ISO 4217 minor units of a currency, or null for a code outside the registry. */
export function currencyMinorUnits(code: string): number | null {
  return SUPPORTED_CURRENCIES.find((currency) => currency.code === code)?.minorUnits ?? null;
}

function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return null;
  try {
    return add(exact, "0");
  } catch {
    return null;
  }
}

/** A rate the ledger can store: positive, at most nine whole digits and ten places. */
export function expenseFxRate(value: unknown): string | null {
  try {
    const rate = updateFxRate({ rate: value });
    return /^[0-9]{1,9}(\.[0-9]{1,10})?$/.test(rate) ? rate : null;
  } catch (error) {
    if (error instanceof CurrencyError) return null;
    throw error;
  }
}

/**
 * Parse an untrusted foreign-currency statement for line `lineNumber`.
 * Every refusal names the line and the field to correct.
 */
export function parseExpenseLineForeign(
  raw: unknown,
  lineNumber: number,
  reportCurrency: string,
): ExpenseLineForeignInput {
  const line = `Line ${lineNumber}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExpenseFxInputError(
      `${line}: the foreign currency details are not readable`,
      "expense_fx_invalid",
      "Enter the currency, amount, expense date and how the amount converts.",
    );
  }
  const value = raw as Record<string, unknown>;
  const currency = typeof value.currency === "string" ? value.currency.trim() : "";
  if (!isIso4217CurrencyCode(currency)) {
    throw new ExpenseFxInputError(
      `${line}: ${JSON.stringify(currency)} is not an ISO 4217 currency code`,
      "expense_fx_currency_invalid",
      "Choose the currency shown on the receipt.",
    );
  }
  if (currency === reportCurrency) {
    throw new ExpenseFxInputError(
      `${line}: the line is already in the report currency ${reportCurrency}`,
      "expense_fx_same_currency",
      `Remove the foreign currency and enter the ${reportCurrency} amount directly.`,
    );
  }
  const amount = exactMoney(value.amount);
  if (amount === null) {
    throw new ExpenseFxInputError(
      `${line}: "${String(value.amount ?? "")}" is not a valid ${currency} amount`,
      "expense_fx_amount_invalid",
      "Enter an exact decimal of at most 4 decimal places.",
    );
  }
  let taxAmount: string | null = null;
  if (
    value.taxAmount !== undefined &&
    value.taxAmount !== null &&
    String(value.taxAmount).trim() !== ""
  ) {
    taxAmount = exactMoney(value.taxAmount);
    if (taxAmount === null) {
      throw new ExpenseFxInputError(
        `${line}: "${String(value.taxAmount)}" is not a valid ${currency} tax amount`,
        "expense_fx_tax_invalid",
        "Enter the tax shown on the receipt as an exact decimal, or leave it blank.",
      );
    }
  }
  const rateDate = typeof value.rateDate === "string" ? value.rateDate.trim() : "";
  if (!isIsoCalendarDate(rateDate)) {
    throw new ExpenseFxInputError(
      `${line}: enter the expense date as YYYY-MM-DD`,
      "expense_fx_date_invalid",
      "The expense date chooses the exchange rate that converts the line.",
    );
  }
  if (!isExpenseFxMethod(value.method)) {
    throw new ExpenseFxInputError(
      `${line}: choose how the ${currency} amount converts`,
      "expense_fx_method_invalid",
      "Use the dated exchange rate, the amount billed in the report currency, or an explicit rate.",
    );
  }
  const method = value.method;
  let rate: string | null = null;
  if (value.rate !== undefined && value.rate !== null && String(value.rate).trim() !== "") {
    rate = expenseFxRate(value.rate);
    if (rate === null) {
      throw new ExpenseFxInputError(
        `${line}: "${String(value.rate)}" is not a usable exchange rate`,
        "expense_fx_rate_invalid",
        "Enter a positive rate with at most nine whole digits and ten decimal places.",
      );
    }
  }
  if (method === "override" && rate === null) {
    throw new ExpenseFxInputError(
      `${line}: enter the exchange rate that applies`,
      "expense_fx_rate_required",
      `Enter how many ${reportCurrency} one ${currency} converted to.`,
    );
  }
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (method === "override" && (reason.length < 8 || reason.length > 500)) {
    throw new ExpenseFxInputError(
      `${line}: explain why the dated exchange rate does not apply (8 to 500 characters)`,
      "expense_fx_reason_required",
      "Name the source of the rate you entered, for example the bank's conversion advice.",
    );
  }
  let billedAmount: string | null = null;
  if (method === "billed_amount") {
    billedAmount = exactMoney(value.billedAmount);
    if (billedAmount === null) {
      throw new ExpenseFxInputError(
        `${line}: enter the amount billed in ${reportCurrency}`,
        "expense_fx_billed_required",
        `Enter the ${reportCurrency} amount on the card or bank statement for this expense.`,
      );
    }
  }
  return {
    currency,
    amount,
    taxAmount,
    rateDate,
    method,
    rate,
    reason: method === "override" ? reason : null,
    billedAmount,
  };
}

/** Convert original amounts at a rate, each rounded to the report currency's minor units. */
export function convertExpenseAtRate(input: {
  amount: string;
  taxAmount: string | null;
  rate: string;
  minorUnits: number;
}): { amount: string; taxAmount: string | null } {
  // One rounding, straight from the exact product to the minor unit.
  const convert = (value: string) =>
    mulDecimalFactors(value, [input.rate], { decimalPlaces: input.minorUnits });
  return {
    amount: convert(input.amount),
    taxAmount: input.taxAmount === null ? null : convert(input.taxAmount),
  };
}

/**
 * Convert original amounts so the converted gross is exactly the billed
 * amount. The tax share is the receipt's tax at the effective rate, and the
 * net absorbs the rounding, so net plus tax always equals the billed amount.
 */
export function convertExpenseFromBilled(input: {
  amount: string;
  taxAmount: string | null;
  billedAmount: string;
  minorUnits: number;
}): { amount: string; taxAmount: string | null; rate: string } | null {
  const gross = add(input.amount, input.taxAmount ?? "0");
  if (cmp(gross, "0") === 0 || cmp(input.billedAmount, "0") === 0) return null;
  if (cmp(gross, "0") > 0 !== cmp(input.billedAmount, "0") > 0) return null;
  const rate = expenseFxRate(divideDecimal(input.billedAmount, gross, 10));
  if (rate === null) return null;
  if (input.taxAmount === null)
    return { amount: add(input.billedAmount, "0"), taxAmount: null, rate };
  // Billed and gross share a sign, so the tax share is tax × |billed| / |gross|,
  // rounded once to the minor unit.
  const magnitude = (units: bigint) => (units < 0n ? -units : units);
  const taxAmount = mulDecimalFactors(input.taxAmount, [], {
    numerator: magnitude(toUnits(input.billedAmount)),
    denominator: magnitude(toUnits(gross)),
    decimalPlaces: input.minorUnits,
  });
  return { amount: add(input.billedAmount, neg(taxAmount)), taxAmount, rate };
}
