/** Transaction price: errors, feature flag, variable consideration, financing, pricing. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { add, cmp, fromUnits, mulPercent, mulRate, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import { periodInterest, periodRateFromAnnualPercent, type AccretionPeriod } from "../money/present-value.ts";

// ---------------------------------------------------------------------------
// Step 3 — determining the transaction price (pure)
// ---------------------------------------------------------------------------

export class TransactionPriceError extends Error {
  readonly name = "TransactionPriceError";
}

export class RevenueRecognitionError extends Error {
  readonly name = "RevenueRecognitionError";
}

/** Registry default is on — absence must not disable recognition. Resolved
 * through the canonical switchboard: the previous inline ::boolean cast
 * threw 22P02 on a non-boolean stored value. */
export async function revenueRecognitionFeatureEnabled(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<boolean> {
  return orgFeatureEnabled(orgId, "revenueRecognition", runner as SqlExecutor);
}

export async function assertEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<void> {
  if (!(await revenueRecognitionFeatureEnabled(runner, orgId))) {
    throw new RevenueRecognitionError("Revenue recognition feature is disabled");
  }
}

/**
 * Base-currency value of one planned transaction-currency amount: the same
 * mulRate conversion the run's journal posts (DR deferred / CR earned are
 * stamped in base). The run total and the preview total both sum THIS, so a
 * mixed-currency run reports the posted base total — never a mixed-currency
 * sum that matches neither the preview nor the ledger.
 */
export function recognitionBaseAmount(planned: string, fxRate: string): string {
  return mulRate(planned, fxRate);
}

export type VariableEstimationMethod = "expected_value" | "most_likely_amount";

export interface VariableConsiderationInput {
  /**
   * Estimation method (ASC 606-10-32-8 / IFRS 15.53): expected value —
   * probability-weighted across possible outcomes (many similar contracts) —
   * or the single most likely amount (two possible outcomes, e.g. a bonus
   * earned or not).
   */
  method: VariableEstimationMethod;
  /** Possible outcomes. Probabilities are percents summing to exactly 100. */
  outcomes: { amount: string; probabilityPercent: string }[];
  /**
   * The constraint (ASC 606-10-32-11 / IFRS 15.56): the amount of the estimate
   * for which it is probable that no significant revenue reversal will occur.
   * Management's documented judgement, capped at the estimate. Omitted = the
   * whole estimate qualifies.
   */
  constraintLimit?: string | null;
}

export interface VariableConsiderationResult {
  method: VariableEstimationMethod;
  /** The raw estimate before applying the constraint. */
  estimate: string;
  /** The amount included in the transaction price. */
  constrained: string;
  /** estimate − constrained: consideration held back until the uncertainty resolves. */
  constrainedOut: string;
}

/**
 * Estimate variable consideration and apply the constraint. Everything is
 * exact decimal arithmetic; probability weights must sum to exactly 100%.
 */
export function estimateVariableConsideration(
  input: VariableConsiderationInput,
): VariableConsiderationResult {
  if (input.outcomes.length === 0) {
    throw new TransactionPriceError("variable consideration requires at least one outcome");
  }
  const probabilitySum = input.outcomes.reduce(
    (total, o) => total + toUnits(o.probabilityPercent),
    0n,
  );
  if (probabilitySum !== toUnits("100")) {
    throw new TransactionPriceError(
      `outcome probabilities must sum to exactly 100% (got ${fromUnits(probabilitySum)})`,
    );
  }

  let estimate: string;
  if (input.method === "expected_value") {
    estimate = sum(input.outcomes.map((o) => mulPercent(o.amount, o.probabilityPercent, 4)));
  } else {
    // Most likely amount: the single outcome with the highest probability.
    // A tie is a judgement the standard does not make for you — refuse it.
    const sorted = [...input.outcomes].sort((a, b) =>
      cmp(b.probabilityPercent, a.probabilityPercent),
    );
    if (
      sorted.length > 1 &&
      cmp(sorted[0]!.probabilityPercent, sorted[1]!.probabilityPercent) === 0
    ) {
      throw new TransactionPriceError(
        "most-likely-amount is ambiguous: two outcomes share the highest probability",
      );
    }
    estimate = fromUnits(toUnits(sorted[0]!.amount));
  }

  const limit = input.constraintLimit;
  if (limit != null && cmp(limit, "0") < 0) {
    throw new TransactionPriceError("constraint limit cannot be negative");
  }
  const constrained =
    limit != null && cmp(limit, estimate) < 0 ? fromUnits(toUnits(limit)) : estimate;
  return {
    method: input.method,
    estimate,
    constrained,
    constrainedOut: add(estimate, neg(constrained)),
  };
}

export interface FinancingComponentInput {
  /** The promised consideration (what will be billed/collected). */
  consideration: string;
  /** Discount rate that reflects a separate financing transaction at inception. */
  annualRatePercent: string;
  /** Whole years between performance and payment. */
  years: number;
}

export interface FinancingComponentResult {
  /** Revenue at inception: the cash selling price (present value). */
  cashSellingPrice: string;
  /** Total interest to accrete between recognition and payment. */
  financingComponent: string;
  /** Year-by-year accretion of the receivable up to the billed amount. */
  accretion: AccretionPeriod[];
}

/**
 * Separate a significant financing component (ASC 606-10-32-15 / IFRS 15.60):
 * revenue is measured at the cash selling price — the promised consideration
 * discounted at the rate a separate financing would carry — and the difference
 * accretes as interest over the payment deferral.
 */
export const MAX_FINANCING_DEFERRAL_YEARS = 100;

export function separateFinancingComponent(
  input: FinancingComponentInput,
): FinancingComponentResult {
  // Whole years only: fractional years discount and accrete over different
  // period counts, and each accepted year costs one loop iteration.
  // The 100-year cap bounds that loop; setContractPricing delegates here,
  // so the persisted path shares it.
  if (
    !Number.isSafeInteger(input.years) ||
    input.years < 1 ||
    input.years > MAX_FINANCING_DEFERRAL_YEARS
  ) {
    throw new TransactionPriceError(
      `financing deferral must be a whole number of years from 1 through ${MAX_FINANCING_DEFERRAL_YEARS}`,
    );
  }
  if (cmp(input.consideration, "0") <= 0) {
    throw new TransactionPriceError("consideration must be positive");
  }
  const rate = periodRateFromAnnualPercent(input.annualRatePercent, 1);

  // A single terminal payment discounted over N periods:
  // PV = consideration · den^N / (den+num)^N, rounded to 4dp exactly once.
  const S = rate.den;
  const D = rate.den + rate.num;
  let numerator = toUnits(input.consideration);
  let denominator = 1n;
  for (let i = 0; i < input.years; i++) {
    numerator *= S;
    denominator *= D;
  }
  const pv = fromUnits(roundDiv(numerator, denominator));

  // Accrete the receivable from the cash selling price up to the consideration:
  // interest each year on the carrying amount, no interim payments, final year
  // plugged so the receivable lands exactly on the billed amount.
  const accretion: AccretionPeriod[] = [];
  let carrying = toUnits(pv);
  const target = toUnits(input.consideration);
  for (let year = 1; year <= input.years; year++) {
    const interest =
      year < input.years ? periodInterest(carrying, rate) : target - carrying;
    if (interest < 0n) throw new TransactionPriceError("financing accretion produced negative interest");
    const closing = carrying + interest;
    accretion.push({
      sequence: year,
      opening: fromUnits(carrying),
      interest: fromUnits(interest),
      payment: "0.0000",
      closing: fromUnits(closing),
    });
    carrying = closing;
  }

  return {
    cashSellingPrice: pv,
    financingComponent: add(input.consideration, neg(pv)),
    accretion,
  };
}

export interface ContractPricingInput {
  /** Fixed consideration promised in the contract. */
  fixedConsideration: string;
  /** Variable consideration, estimated and constrained. Omitted = none. */
  variable?: VariableConsiderationInput | null;
  /** Significant financing component to separate. Omitted = none. */
  financing?: { annualRatePercent: string; years: number } | null;
}

export interface ContractPricingResult {
  contractId: string;
  /** Fixed + constrained variable (the undiscounted promised consideration). */
  promisedConsideration: string;
  /** What revenue is measured at: promised consideration less any financing. */
  transactionPrice: string;
  variable: VariableConsiderationResult | null;
  financing: FinancingComponentResult | null;
}

/**
 * Determine and persist a revenue contract's transaction price (ASC 606 step
 * 3): fixed consideration plus CONSTRAINED variable consideration, less any
 * significant financing component (revenue is measured at the cash selling
 * price; the financing accretes as interest). The full computation is stored
 * on the contract as `pricing` evidence and the resolved price lands in
 * `total_transaction_price`.
 */
export async function setContractPricing(
  orgId: string,
  contractId: string,
  input: ContractPricingInput,
  actorId: string | null,
): Promise<ContractPricingResult> {
  if (cmp(input.fixedConsideration, "0") < 0) {
    throw new TransactionPriceError("fixed consideration cannot be negative");
  }
  const variable = input.variable ? estimateVariableConsideration(input.variable) : null;
  const promised = add(input.fixedConsideration, variable?.constrained ?? "0");
  const financing = input.financing
    ? separateFinancingComponent({
        consideration: promised,
        annualRatePercent: input.financing.annualRatePercent,
        years: input.financing.years,
      })
    : null;
  const transactionPrice = financing ? financing.cashSellingPrice : fromUnits(toUnits(promised));

  const updated = (await db.execute<{ id: string }>(sql`
    update revenue_contracts
       set pricing = ${JSON.stringify({
         fixedConsideration: fromUnits(toUnits(input.fixedConsideration)),
         variable,
         financing: financing
           ? {
               annualRatePercent: input.financing!.annualRatePercent,
               years: input.financing!.years,
               cashSellingPrice: financing.cashSellingPrice,
               financingComponent: financing.financingComponent,
             }
           : null,
         promisedConsideration: fromUnits(toUnits(promised)),
         transactionPrice,
       })}::jsonb,
           total_transaction_price = ${transactionPrice},
           updated_at = now(), updated_by = ${actorId}
     where id = ${contractId} and org_id = ${orgId}
       and not exists (select 1 from performance_obligations o where o.org_id=${orgId} and o.contract_id=${contractId})
     returning id`));
  if (!updated.rows[0]) throw new TransactionPriceError("contract not found or already allocated; propose a contract modification from Revenue → contract → Modify contract");

  return {
    contractId,
    promisedConsideration: fromUnits(toUnits(promised)),
    transactionPrice,
    variable,
    financing,
  };
}
