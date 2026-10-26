import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, divRate, fromUnits, mulRate, mulRatio, neg, toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { CurrencyError, updateFxRate } from "../fx/currencies.ts";

export type SettlementRateSource =
  "same_currency" | "provider" | "manual" | "contractual" | "imported";
export interface AllocationInput {
  openLineId: string;
  /** Amount consumed from the payment/credit source, in the payment currency. */
  sourceTransactionAmount: string;
  /** Amount extinguished on the invoice/bill, in the target open-item currency. */
  targetTransactionAmount: string;
  /** Optional independently saved target carrying value, revalidated at posting. */
  targetBaseAmount?: string;
  /** Target-currency units for one source-currency unit. Required cross-currency. */
  settlementRate: string;
  settlementRateSource: SettlementRateSource;
  /** Bank advice, contract, provider observation, or import evidence reference. */
  settlementRateReference: string;
  /** Tenant-owned fx_rates observation when settlementRateSource is provider. */
  settlementFxRateId?: string | null;
}

/** Persist-time payment FX rate: exact positive decimal with a numeric(19,10) inverse. */
export function persistPaymentFxRate(value: unknown): string {
  try {
    return updateFxRate({ rate: value });
  } catch (error) {
    if (error instanceof CurrencyError) {
      throw new PaymentError(error.message.replace(/^FX rate/, "exchange rate"));
    }
    throw error;
  }
}

/**
 * Draft discount/fee/on-account inputs must be exact 4dp amounts the
 * numeric(19,4) header/total columns can hold. Reading them with toUnits
 * directly threw a bare Error on junk text (a 500 at the payments API, which
 * maps only PaymentError to 422) and admitted any magnitude (a storage
 * failure on save), so both fail closed here as PaymentError.
 */
export function persistPaymentMoney(value: unknown, label: string): bigint {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new PaymentError(`${label} must be an exact decimal amount of at most 4 decimal places`);
  }
  let units: bigint;
  try {
    units = toUnits(exact);
  } catch {
    throw new PaymentError(`${label} must be an exact decimal amount of at most 4 decimal places`);
  }
  const whole = (units < 0n ? -units : units) / 10_000n;
  if (whole >= 10n ** 15n) {
    throw new PaymentError(`${label} is out of range — at most 15 whole digits fit the ledger`);
  }
  return units;
}

export function sameCurrencyAllocation(
  openLineId: string,
  amount: string,
  targetBaseAmount?: string,
): AllocationInput {
  return {
    openLineId,
    sourceTransactionAmount: amount,
    targetTransactionAmount: amount,
    ...(targetBaseAmount === undefined ? {} : { targetBaseAmount }),
    settlementRate: "1",
    settlementRateSource: "same_currency",
    settlementRateReference: "same transaction currency",
  };
}

/**
 * The source-currency amount that settles a target-currency balance at a
 * settlement rate (target units per source unit), within the exact
 * cross-foot every allocation must satisfy: the largest four-place source
 * whose `mulRate(source, rate)` does not exceed the target. `settles` is that
 * cross-rate; it equals the target whenever the rate admits an exact source,
 * and otherwise falls short of it by less than one rounding unit.
 */
export function sourceSettlingTarget(
  target: string,
  rate: string,
): { source: string; settles: string } {
  const targetUnits = toUnits(target);
  if (targetUnits <= 0n) throw new PaymentError("a settled balance must be positive");
  let source = toUnits(divRate(target, rate));
  while (source > 0n && toUnits(mulRate(fromUnits(source), rate)) > targetUnits) source -= 1n;
  while (toUnits(mulRate(fromUnits(source + 1n), rate)) <= targetUnits) source += 1n;
  if (source <= 0n)
    throw new PaymentError("the settlement rate settles nothing of this balance; check the rate");
  return { source: fromUnits(source), settles: mulRate(fromUnits(source), rate) };
}

/**
 * The ten-place rate that measures `transaction` at exactly `carrying`
 * (`mulRate(transaction, rate) === carrying`): the rate a balance is carried
 * at, recovered from its two frames so a document posted at it clears the
 * carrying amount to the minor unit. The nearest rate when no ten-place rate
 * is exact (only for amounts beyond the precision a rate can express).
 */
export function rateMeasuringExactly(
  transaction: string,
  carrying: string,
): { rate: string; exact: boolean } {
  const amount = toUnits(transaction);
  const base = toUnits(carrying);
  if (amount <= 0n || base <= 0n)
    throw new PaymentError("a carrying rate needs positive transaction and carrying amounts");
  const scale = 10_000_000_000n;
  const nearest = (base * scale + amount / 2n) / amount;
  const render = (units: bigint) =>
    `${units / scale}.${(units % scale).toString().padStart(10, "0")}`;
  for (let step = 0n; step <= 1000n; step += 1n) {
    for (const candidate of step === 0n ? [nearest] : [nearest - step, nearest + step]) {
      if (candidate > 0n && toUnits(mulRate(transaction, render(candidate))) === base)
        return { rate: render(candidate), exact: true };
    }
  }
  return { rate: render(nearest > 0n ? nearest : 1n), exact: false };
}

/** Settlement-rate evidence for a cross-currency application, as the payment drawers record it. */
export interface CrossCurrencyEvidence {
  rate: string;
  source: Exclude<SettlementRateSource, "same_currency">;
  reference: string;
  fxRateId?: string | null;
}

/**
 * A cross-currency allocation of `sourceAmount` (payment currency) at the
 * evidenced rate: the target extinguished is exactly the cross-rate, so the
 * allocation cross-foots by construction.
 */
export function crossCurrencyAllocation(
  openLineId: string,
  sourceAmount: string,
  evidence: CrossCurrencyEvidence,
): AllocationInput {
  return {
    openLineId,
    sourceTransactionAmount: fromUnits(toUnits(sourceAmount)),
    targetTransactionAmount: mulRate(sourceAmount, evidence.rate),
    settlementRate: canonicalSettlementRate(evidence.rate),
    settlementRateSource: evidence.source,
    settlementRateReference: evidence.reference,
    ...(evidence.fxRateId ? { settlementFxRateId: evidence.fxRateId } : {}),
  };
}

/** Validate allocation shape: positive exact amounts, rate evidence, distinct lines. */
export function validateAllocationInputs(allocations: AllocationInput[]): void {
  const seen = new Set<string>();
  for (const a of allocations) {
    if (!a.openLineId) throw new PaymentError("allocation is missing its open item line");
    if (seen.has(a.openLineId)) throw new PaymentError("the same open item is allocated twice");
    seen.add(a.openLineId);
    try {
      if (toUnits(a.sourceTransactionAmount) <= 0n || toUnits(a.targetTransactionAmount) <= 0n) {
        throw new Error("transaction amounts must be positive");
      }
      if (a.targetBaseAmount !== undefined && toUnits(a.targetBaseAmount) <= 0n) {
        throw new Error("target base amount must be positive");
      }
      // Also validates numeric(19,10) precision and positivity.
      mulRate(a.sourceTransactionAmount, a.settlementRate);
    } catch {
      throw new PaymentError(
        "allocation amounts and settlement rate must be positive exact decimals",
      );
    }
    if (!a.settlementRateReference?.trim())
      throw new PaymentError("settlement-rate evidence reference is required");
    if (
      !["same_currency", "provider", "manual", "contractual", "imported"].includes(
        a.settlementRateSource,
      )
    ) {
      throw new PaymentError("settlement-rate evidence source is invalid");
    }
  }
}

/**
 * Compare the allocation workpaper as an approved snapshot, not as a raw JSON
 * string. Decimal spellings and row order are presentation details; the open
 * item, amounts, settlement evidence, and rate are the approval scope.
 */
function allocationSnapshot(allocations: AllocationInput[]): string[] {
  return allocations
    .map((allocation) =>
      JSON.stringify({
        openLineId: allocation.openLineId,
        sourceTransactionAmount: fromUnits(toUnits(allocation.sourceTransactionAmount)),
        targetTransactionAmount: fromUnits(toUnits(allocation.targetTransactionAmount)),
        targetBaseAmount:
          allocation.targetBaseAmount === undefined
            ? null
            : fromUnits(toUnits(allocation.targetBaseAmount)),
        settlementRate: canonicalSettlementRate(allocation.settlementRate),
        settlementRateSource: allocation.settlementRateSource,
        settlementRateReference: allocation.settlementRateReference.trim(),
        settlementFxRateId: allocation.settlementFxRateId ?? null,
      }),
    )
    .sort();
}

export function allocationsMatchApprovedSnapshot(
  submitted: AllocationInput[],
  approved: AllocationInput[],
): boolean {
  const submittedSnapshot = allocationSnapshot(submitted);
  const approvedSnapshot = allocationSnapshot(approved);
  return (
    submittedSnapshot.length === approvedSnapshot.length &&
    submittedSnapshot.every((value, index) => value === approvedSnapshot[index])
  );
}

export function canonicalSettlementRate(rate: string): string {
  const raw = String(rate).trim();
  const match = raw.match(/^\+?(\d+)(?:\.(\d*))?$/);
  if (!match || (match[2]?.length ?? 0) > 10) {
    throw new PaymentError(
      "settlement rate must be a positive decimal with at most ten decimal places",
    );
  }
  const whole = BigInt(match[1]!).toString();
  const fraction = (match[2] ?? "").padEnd(10, "0");
  if (BigInt(whole) === 0n && !/[1-9]/.test(fraction))
    throw new PaymentError("settlement rate must be positive");
  return `${whole}.${fraction}`;
}

export function validateSettlementEvidence(
  allocation: AllocationInput,
  sourceCurrency: string,
  targetCurrency: string,
): void {
  if (
    cmp(
      mulRate(allocation.sourceTransactionAmount, allocation.settlementRate),
      allocation.targetTransactionAmount,
    ) !== 0
  ) {
    throw new PaymentError(
      "settlement rate does not cross-foot source and target transaction amounts",
    );
  }
  if (sourceCurrency === targetCurrency) {
    if (
      cmp(allocation.sourceTransactionAmount, allocation.targetTransactionAmount) !== 0 ||
      canonicalSettlementRate(allocation.settlementRate) !== "1.0000000000" ||
      allocation.settlementRateSource !== "same_currency" ||
      allocation.settlementFxRateId
    ) {
      throw new PaymentError("same-currency applications require equal amounts and a rate of one");
    }
    return;
  }
  if (allocation.settlementRateSource === "same_currency") {
    throw new PaymentError("cross-currency applications require explicit settlement-rate evidence");
  }
  if (allocation.settlementRateSource === "provider" && !allocation.settlementFxRateId) {
    throw new PaymentError("provider settlement evidence requires an FX rate observation");
  }
}

/** Exact carrying amount consumed by a transaction-currency settlement. */
export function carryingAmountForSettlement(
  openBase: string,
  openTransaction: string,
  settledTransaction: string,
): string {
  if (cmp(settledTransaction, "0") <= 0 || cmp(settledTransaction, openTransaction) > 0) {
    throw new PaymentError(
      "settlement amount must be positive and cannot exceed the open transaction amount",
    );
  }
  // Taking the complete residual consumes the complete carrying value. This
  // prevents proportional rounding from leaving an uncloseable 0.0001 tail.
  if (cmp(settledTransaction, openTransaction) === 0) return openBase;
  return mulRatio(openBase, toUnits(settledTransaction), toUnits(openTransaction));
}

/**
 * Control-account adjustment required to clear source and target carrying
 * values. Positive is a debit; its exact opposite is realized gain/loss.
 */
export function realizedFxControlAdjustment(
  sourceSignedAmount: string,
  targetSignedAmount: string,
): string {
  return neg(add(sourceSignedAmount, targetSignedAmount));
}
