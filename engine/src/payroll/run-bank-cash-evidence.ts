import { canonicalDecimal, multiplyDecimal, subtractDecimal } from "../money/exact-decimal.ts";
import { cmp, normalizeMoney, roundMoney } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";

export type BankCashInputEvidence = {
  kind: "bank_cash_input";
  reason: string;
  sourceReference: string;
  requestId: string;
  rate: string | null;
  /** Portion of an issued withdrawal paid outside the entitlement bank. */
  outsideBankAmount?: string;
};

export type BankCashFundingSplit = {
  totalAmount: string;
  bankFundedAmount: string;
  outsideBankAmount: string;
};

/**
 * The native wage source a split's bank-funded portion is valued at: the
 * winning dated wage row on the pay date and the exact hourly wage it
 * resolves to. Retained with the calculation so a later wage edit reads
 * stale instead of silently repricing an issued split.
 */
export type BankCashPayDateValuation = {
  rateId: string;
  scope: string;
  hourlyWage: string;
  currency: string;
  basis: string;
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualHoursUsed: string | null;
  annualHoursSource: "rate" | "labor_costing_settings" | null;
  updatedAt: string | null;
};

/** Split an issued positive bank payout without changing its gross cash amount. */
export function bankCashFundingSplit(
  totalAmount: string,
  outsideBankAmount: string,
): BankCashFundingSplit | null {
  const exactTotal = canonicalDecimal(totalAmount, 4);
  const total = exactTotal === null ? null : roundMoney(exactTotal, 2);
  const outside = canonicalDecimal(outsideBankAmount, 2);
  if (
    exactTotal === null ||
    total === null ||
    cmp(total, exactTotal) !== 0 ||
    outside === null ||
    cmp(total, "0") <= 0 ||
    cmp(outside, "0") <= 0 ||
    cmp(outside, total) >= 0
  )
    return null;
  const bankFundedAmount = subtractDecimal(total, outside);
  if (cmp(bankFundedAmount, "0") <= 0) return null;
  return { totalAmount: total, bankFundedAmount, outsideBankAmount: outside };
}

/** Exact cents a split's bank-funded portion must carry at the native pay-date wage. */
export function bankFundedValuationCents(
  hours: string,
  valuation: BankCashPayDateValuation,
): string {
  return roundMoney(multiplyDecimal(valuation.hourlyWage, hours.replace(/^[+-]/, ""), 4), 2);
}

/** True when the split's bank-funded portion is exactly its hours at the retained wage. */
export function bankCashSplitMatchesValuation(
  split: BankCashFundingSplit,
  hours: string,
  valuation: BankCashPayDateValuation,
): boolean {
  return (
    cmp(hours, "0") > 0 &&
    cmp(bankFundedValuationCents(hours, valuation), split.bankFundedAmount) === 0
  );
}

export function parseBankCashInputEvidence(value: string | null): BankCashInputEvidence | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<BankCashInputEvidence>;
    if (
      parsed.kind !== "bank_cash_input" ||
      typeof parsed.reason !== "string" ||
      !parsed.reason.trim() ||
      parsed.reason.length > 500 ||
      typeof parsed.sourceReference !== "string" ||
      !parsed.sourceReference.trim() ||
      parsed.sourceReference.length > 300 ||
      typeof parsed.requestId !== "string" ||
      !isUuid(parsed.requestId) ||
      !(parsed.rate === null || typeof parsed.rate === "string") ||
      !(parsed.outsideBankAmount === undefined || typeof parsed.outsideBankAmount === "string")
    )
      return null;
    if (parsed.rate !== null) {
      const rate = canonicalDecimal(parsed.rate, 2);
      if (
        rate === null ||
        cmp(rate, "0") <= 0 ||
        rate !== parsed.rate ||
        rate.split(".")[0]!.replace(/^0+/, "").length > 15
      )
        return null;
    }
    if (parsed.outsideBankAmount !== undefined) {
      const outside = canonicalDecimal(parsed.outsideBankAmount, 2);
      if (outside === null || cmp(outside, "0") <= 0 || outside !== parsed.outsideBankAmount)
        return null;
    }
    return parsed as BankCashInputEvidence;
  } catch {
    return null;
  }
}

export function bankCashInputEvidence(
  reason: string,
  sourceReference: string,
  requestId: string,
  rate: string | null,
  outsideBankAmount: string | null = null,
): string {
  return JSON.stringify({
    kind: "bank_cash_input",
    reason,
    sourceReference,
    requestId,
    rate,
    ...(outsideBankAmount === null ? {} : { outsideBankAmount }),
  } satisfies BankCashInputEvidence);
}

export function isBankCashInputEvidenceCandidate(value: string | null): boolean {
  if (value == null) return false;
  if (/"kind"\s*:\s*"bank_cash_input"/.test(value)) return true;
  try {
    const parsed = JSON.parse(value) as { kind?: unknown };
    return parsed !== null && typeof parsed === "object" && parsed.kind === "bank_cash_input";
  } catch {
    return false;
  }
}

/** Issued cash and hours are independent exact inputs; a keyed rate must agree. */
export function canonicalBankCashInputValues(input: {
  hours: string;
  amount?: string | null;
  rate?: string | null;
}): { hours: string; amount: string; rate: string | null } {
  const hoursExact = canonicalDecimal(input.hours, 2);
  if (
    hoursExact === null ||
    cmp(hoursExact, "0") === 0 ||
    hoursExact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10
  ) {
    throw new PayrollError(
      "bank cash input needs non-zero paid or deposited hours of at most 2 decimal places and 10 whole digits",
    );
  }
  const rateExact =
    input.rate == null || input.rate === "" ? null : canonicalDecimal(input.rate, 2);
  if (input.rate != null && input.rate !== "" && (rateExact === null || cmp(rateExact, "0") <= 0)) {
    throw new PayrollError("bank cash input rate must be a positive hourly rate in cents");
  }
  const suppliedAmount =
    input.amount == null || input.amount === "" ? null : canonicalDecimal(input.amount, 2);
  if (input.amount != null && input.amount !== "" && suppliedAmount === null) {
    throw new PayrollError("bank cash input amount must be an exact currency amount in cents");
  }
  if (rateExact !== null && rateExact.split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new PayrollError(
      "bank cash input rate is out of range — at most 15 whole digits fit the ledger",
    );
  }
  if (rateExact === null && suppliedAmount === null) {
    throw new PayrollError("enter the issued bank-line amount or its keyed hourly rate");
  }
  const absHours = hoursExact.startsWith("-") ? hoursExact.slice(1) : hoursExact;
  const rateAmount = rateExact === null ? null : multiplyDecimal(rateExact, absHours, 2);
  const pricedAmount =
    rateAmount === null ? null : hoursExact.startsWith("-") ? `-${rateAmount}` : rateAmount;
  if (pricedAmount !== null && suppliedAmount !== null && cmp(pricedAmount, suppliedAmount) !== 0) {
    throw new PayrollError(
      "the keyed bank-line rate and hours do not equal the supplied issued amount",
    );
  }
  const exactAmount = suppliedAmount ?? pricedAmount;
  if (
    exactAmount === null ||
    exactAmount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15
  ) {
    throw new PayrollError(
      "bank cash input amount is out of range — at most 15 whole digits fit the ledger",
    );
  }
  const amount = normalizeMoney(exactAmount);
  if (cmp(amount, "0") === 0) throw new PayrollError("bank cash input amount must be non-zero");
  const hours = hoursExact;
  if (cmp(hours, "0") > 0 !== cmp(amount, "0") > 0) {
    throw new PayrollError(
      "bank withdrawals need positive hours and cash; bank deposits need negative hours and cash",
    );
  }
  return { hours, amount, rate: rateExact };
}
