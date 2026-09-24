import { createHash } from "node:crypto";
import { measureCreditExposure, type CreditExposure } from "./deferred-credit-pool.ts";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { canonicalDecimal, fixedDecimal } from "../money/exact-decimal.ts";
import { db, type SqlExecutor, withOrg, withTransactionSavepoint } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { add, cmp, fromUnits, isZero, mulPercent, mulRate, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import {
  periodInterest,
  periodRateFromAnnualPercent,
  type AccretionPeriod,
} from "../money/present-value.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { isLegacyProvenance } from "../platform/legacy-provenance.ts";
import {
  MAX_RECOGNITION_DAY_OFFSET,
  MAX_RECOGNITION_INITIAL_PERCENT,
  MAX_RECOGNITION_TERM_MONTHS,
  MIN_RECOGNITION_DAY_OFFSET,
  MIN_RECOGNITION_INITIAL_PERCENT,
} from "./recognition-limits.ts";

export { MAX_RECOGNITION_TERM_MONTHS };
import { arePeriodModulesOpen, assertPeriodModulesOpen, CloseError } from "../close/period-policy.ts";
import { resolveCoveringPeriod } from "../close/period-resolution.ts";

/**
 * Revenue recognition (ASC 606 / IFRS 15), source platform ARM-shaped.
 *
 * An obligation carries an allocated amount to recognize over a term. A rule
 * (method + date sources + offsets + accounts) spreads that amount into a
 * per-book, per-period plan (recognition_schedules + one line per period). All
 * of it is org-configured data — see schema/src/revenue.ts.
 *
 * runRevenueRecognition(asOfDate) walks every schedule line whose period has
 * ended on or before the as-of date and is not yet posted, and posts one
 * balanced system journal per line straight through the kernel:
 *
 *     DR deferred revenue      (planned amount)
 *     CR recognized revenue    (planned amount)
 *
 * origin = 'revenue_recognition'; the entry is NOT a document. Idempotency: a
 * line is "posted" once its journal_entry_id is set, so re-running never
 * double-posts. The upstream invoice must have parked the money in deferred
 * revenue (posting.ts credits the item's deferred account for rev-rec lines),
 * so recognition simply drains deferred → earned over the term.
 *
 * A manual credit memo against the source invoice relieves deferred revenue
 * WITHOUT touching the plan — so the run caps every posting at what remains
 * genuinely unearned (allocated − recognized − credited-to-deferred). After a
 * full-remainder credit the run posts nothing; after a partial credit it posts
 * only the remainder (the final line may post partial). Credits that debit an
 * income account instead — a concession while service continues — never count:
 * they reduce earned directly and must not retire the plan.
 */

export type RecognitionMethod =
  | "point_in_time"
  | "straight_line_even"
  | "straight_line_prorate_first_last"
  | "straight_line_daily"
  | "percent_complete"
  | "milestone"
  | "usage";

// ---------------------------------------------------------------------------
// Date helpers (UTC, no wall-clock dependency)
// ---------------------------------------------------------------------------

function recognitionDate(value: string, label = "recognition date"): Date {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : new Date(NaN);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || value.startsWith("0000-") || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RevenueRecognitionError(`${label} must be a valid ISO calendar date`);
  }
  return date;
}

function recognitionInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_RECOGNITION_DAY_OFFSET) {
    throw new RevenueRecognitionError(`${label} must be a whole number from ${minimum} through ${MAX_RECOGNITION_DAY_OFFSET}`);
  }
  return value;
}

function recognitionEventDecimal(value: string, label: string): string {
  const decimal = typeof value === "string" ? canonicalDecimal(value, 4) : null;
  if (decimal === null || decimal.replace(/^-/, "").split(".")[0]!.length > 15) {
    throw new RevenueRecognitionError(`${label} must be an exact decimal within numeric(19,4) precision`);
  }
  return decimal;
}

function eventMonth(value: string): void {
  recognitionDate(value, "event month");
  if (!value.endsWith("-01")) throw new RevenueRecognitionError("event month must be the first day of a calendar month");
}

/** First day of the month for a YYYY-MM-DD date, as YYYY-MM-01. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + n;
  const ny = Math.floor(total / 12);
  if (ny < 1 || ny > 9999) throw new RevenueRecognitionError("recognition date exceeds the supported calendar");
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/** Days in the calendar month containing a YYYY-MM-DD date. */
function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  const end = new Date(0);
  end.setUTCFullYear(y!, m!, 0);
  return end.getUTCDate();
}

/** Last day of the month for a YYYY-MM-DD date, as YYYY-MM-DD. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(daysInMonth(date)).padStart(2, "0")}`;
}

/** Parse YYYY-MM-DD to a UTC epoch-day integer. */
function epochDay(date: string): number {
  return Math.floor(recognitionDate(date).getTime() / 86_400_000);
}

/** Inclusive day count between two YYYY-MM-DD dates (end − start + 1). */
function inclusiveDays(startOn: string, endOn: string): number {
  return epochDay(endOn) - epochDay(startOn) + 1;
}

/** Shift a YYYY-MM-DD date by n days, returning YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  recognitionInteger(n, "day offset", MIN_RECOGNITION_DAY_OFFSET);
  const dt = new Date((epochDay(date) + n) * 86_400_000);
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() < 1 || dt.getUTCFullYear() > 9999) {
    throw new RevenueRecognitionError("recognition date exceeds the supported calendar");
  }
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Exact apportionment (integer money units, no drift)
// ---------------------------------------------------------------------------

/**
 * Split `totalUnits` across `weights` so the parts are proportional and sum
 * EXACTLY to the total (largest-remainder / Hamilton apportionment). A zero
 * total or non-positive weight sum yields all zeros.
 */
export function apportion(totalUnits: bigint, weights: readonly (number | string | bigint)[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  const iw = weights.map((weight) => {
    if (typeof weight === "bigint") return weight > 0n ? weight : 0n;
    const units = toUnits(String(weight));
    return units > 0n ? units : 0n;
  });
  const iwsum = iw.reduce((a, b) => a + b, 0n);
  if (iwsum === 0n || totalUnits === 0n) return new Array(n).fill(0n);

  const negative = totalUnits < 0n;
  const total = negative ? -totalUnits : totalUnits;

  const base = iw.map((w) => (total * w) / iwsum);
  const distributed = base.reduce((a, b) => a + b, 0n);
  let remainder = total - distributed;

  // Hand leftover units out by descending fractional part (stable by index).
  const order = iw
    .map((w, i) => ({ i, frac: (total * w) % iwsum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    base[order[k % order.length]!.i]! += 1n;
    remainder -= 1n;
    k++;
  }
  return negative ? base.map((u) => -u) : base;
}

/**
 * Allocate a bundle's transaction price across obligations in proportion to
 * their standalone selling price (relative-SSP method, ASC 606-10-32-31).
 * Returns allocated amounts (decimal strings) that sum EXACTLY to `total`.
 * SSP is per unit; quantities retain the document's eight decimal places.
 * Obligations with no SSP use their already-extended booked amount as weight.
 */
export function allocateByRelativeSSP(
  total: string,
  obligations: { ssp?: string | null; booked?: string | null; quantity?: string | null }[],
): string[] {
  const weights = obligations.map((o) => {
    if (o.ssp != null && o.ssp !== "" && toUnits(o.ssp) < 0n) {
      throw new RevenueRecognitionError("Revenue allocation requires non-negative selling prices");
    }
    // Keep the unrounded product at scale 12, including sub-money-unit SSPs.
    // Rounding each extended SSP first can erase a valid allocation weight.
    const weight = o.ssp != null && o.ssp !== ""
      ? toUnits(o.ssp) * recognitionQuantityUnits(o.quantity ?? "1")
      : toUnits(o.booked ?? "0") * 100_000_000n;
    if (weight < 0n) throw new RevenueRecognitionError("Revenue allocation requires non-negative selling prices and weights");
    return weight;
  });
  const totalUnits = toUnits(total);
  if (totalUnits !== 0n && weights.every((weight) => weight === 0n)) {
    throw new RevenueRecognitionError("Revenue allocation requires a positive selling price weight for a nonzero total");
  }
  return apportion(totalUnits, weights).map(fromUnits);
}

function recognitionQuantityUnits(quantity: string): bigint {
  const value = typeof quantity === "string" ? canonicalDecimal(quantity, 8) : null;
  if (value === null || value.startsWith("-") || value.split(".")[0]!.length > 20) {
    throw new RevenueRecognitionError("Revenue quantity must be a non-negative exact numeric(28,8) decimal");
  }
  return BigInt(fixedDecimal(value, 8).replace(".", ""));
}

/**
 * Fair-value range review (source platform fair-value range policy): compare an
 * obligation's allocated PER-UNIT price against the matched fair value price's
 * [low, high] bounds. Either bound may be absent (open-ended range). Returns
 * null when in range or when no bound is configured. Cross multiplication
 * avoids division and makes exact boundary decisions.
 */
export function fairValueRangeFlag(
  allocated: string,
  quantity: string | null | undefined,
  low: string | null,
  high: string | null,
): "below_range" | "above_range" | null {
  if (low == null && high == null) return null;
  const quantityUnits = recognitionQuantityUnits(quantity ?? "1");
  const qty = quantityUnits > 0n ? quantityUnits : 100_000_000n;
  const amount = toUnits(allocated) * 100_000_000n;
  if (low != null && amount < toUnits(low) * qty) return "below_range";
  if (high != null && amount > toUnits(high) * qty) return "above_range";
  return null;
}

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

async function assertEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Schedule computation (pure)
// ---------------------------------------------------------------------------

export interface RecognitionInput {
  /** Amount to recognize over the term (post-allocation), decimal string. */
  total: string;
  method: RecognitionMethod;
  /** Recognition start, YYYY-MM-DD. */
  startOn: string;
  /** Recognition end, YYYY-MM-DD (required for prorate / daily precision). */
  endOn?: string | null;
  /** Term length in months, used when endOn is absent (even/prorate/daily). */
  termPeriods?: number | null;
  /** Shift the start date by N days before spreading. */
  startOffsetDays?: number | null;
  /** Percent (0..100) recognized up front in the first period. */
  initialAmountPercent?: string | null;
  /** Shift the whole schedule later by N periods (deferral). */
  periodOffset?: number | null;
  // percent_complete inputs:
  percentComplete?: string | null; // 0..100 cumulative target
  alreadyRecognized?: string | null; // recognized-to-date, decimal string
  /** Explicit period amounts for milestone / usage methods (YYYY-MM-01 → amount). */
  events?: { periodMonth: string; amount: string }[];
}

export interface RecognitionLinePlan {
  sequence: number;
  /** YYYY-MM-01 — the accounting month this recognition belongs to. */
  periodMonth: string;
  /** planned recognition for the month, decimal string (may be 0). */
  planned: string;
  /** cumulative recognized through and including this month. */
  cumulative: string;
}

/** Cumulative-percent × total, exact to 4dp. */
function pctOf(totalUnits: bigint, pct: string): bigint {
  try {
    if (cmp(pct, MIN_RECOGNITION_INITIAL_PERCENT) < 0 || cmp(pct, MAX_RECOGNITION_INITIAL_PERCENT) > 0) throw new Error("out of range");
    return toUnits(mulPercent(fromUnits(totalUnits), pct, 4));
  } catch {
    throw new RevenueRecognitionError(`recognition percentage must be a decimal from ${MIN_RECOGNITION_INITIAL_PERCENT} through ${MAX_RECOGNITION_INITIAL_PERCENT}`);
  }
}

/** Resolve the term end from an explicit endOn, else start + termPeriods. */
function resolveEnd(startOn: string, input: RecognitionInput): string {
  if (input.endOn) return input.endOn;
  const term = recognitionInteger(input.termPeriods ?? 1, "recognition term", 1);
  return monthEnd(addMonths(monthStart(startOn), term - 1));
}

/** Whole calendar months a term spans, inclusive of first and last. */
function monthSpan(startOn: string, endOn: string): number {
  const [sy, sm] = monthStart(startOn).split("-").map(Number);
  const [ey, em] = monthStart(endOn).split("-").map(Number);
  return ey! * 12 + (em! - 1) - (sy! * 12 + (sm! - 1)) + 1;
}

/**
 * Spread the total across the given month weights, honoring an initial up-front
 * percentage recognized in the first period on top of its ratable share.
 * Returns { month, units } aligned to `start` + i months.
 */
function spreadWithInitial(input: RecognitionInput, start: string, weights: number[]): { month: string; units: bigint }[] {
  const totalUnits = toUnits(input.total);
  const initialUnits = pctOf(totalUnits, input.initialAmountPercent ?? "0");
  const parts = apportion(totalUnits - initialUnits, weights);
  if (weights.length > 0) parts[0]! += initialUnits;
  return parts.map((units, i) => ({ month: addMonths(start, i), units }));
}

/**
 * Compute the period-by-period recognition plan for one obligation. Every
 * method recognizes from the (offset) start month forward and sums EXACTLY to
 * the recognizable amount — the apportionment never loses or invents a cent.
 */
export function computeRecognitionSchedule(input: RecognitionInput): RecognitionLinePlan[] {
  recognitionDate(input.startOn, "recognition start");
  if (input.endOn != null) recognitionDate(input.endOn, "recognition end");
  if (input.termPeriods != null) {
    recognitionInteger(input.termPeriods, "recognition term", 1);
    if (input.termPeriods > MAX_RECOGNITION_TERM_MONTHS) {
      throw new RevenueRecognitionError(
        `recognition term must be a whole number from 1 through ${MAX_RECOGNITION_TERM_MONTHS} months`,
      );
    }
  }
  const periodOffset = recognitionInteger(input.periodOffset ?? 0, "period offset", 0);
  if (periodOffset > MAX_RECOGNITION_TERM_MONTHS) {
    throw new RevenueRecognitionError(
      `period offset must be a whole number from 0 through ${MAX_RECOGNITION_TERM_MONTHS}`,
    );
  }
  const rawStart = addDays(input.startOn, input.startOffsetDays ?? 0);
  const start = monthStart(rawStart);

  // Fail closed on an inverted term: end-before-start clamps every weight to
  // zero in apportion(), silently planning an all-zero schedule instead of
  // recognizing anything.
  if (
    input.method === "straight_line_even" ||
    input.method === "straight_line_prorate_first_last" ||
    input.method === "straight_line_daily"
  ) {
    const end = resolveEnd(rawStart, input);
    if (epochDay(end) < epochDay(rawStart)) {
      throw new RevenueRecognitionError(`recognition end (${end}) precedes the recognition start (${rawStart})`);
    }
    // Cap explicit endOn spans too: without this, a centuries-wide date
    // range allocates one array entry per month before anything else runs.
    if (monthSpan(rawStart, end) > MAX_RECOGNITION_TERM_MONTHS) {
      throw new RevenueRecognitionError(
        `recognition schedule must span no more than ${MAX_RECOGNITION_TERM_MONTHS} months`,
      );
    }
  }

  const lines: { month: string; units: bigint }[] = (() => {
    switch (input.method) {
      case "point_in_time":
        return [{ month: start, units: toUnits(input.total) }];

      case "percent_complete": {
        // Cumulative catch-up, BOTH directions (ASC 606 over-time): a falling
        // estimate reverses previously recognized revenue in the current period.
        const targetUnits = pctOf(toUnits(input.total), input.percentComplete ?? "0");
        const already = toUnits(input.alreadyRecognized ?? "0");
        return [{ month: start, units: targetUnits - already }];
      }

      case "milestone":
      case "usage":
        return (input.events ?? []).map((e) => {
          eventMonth(e.periodMonth);
          return { month: e.periodMonth, units: toUnits(e.amount) };
        });

      case "straight_line_even": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        return spreadWithInitial(input, start, new Array(n).fill(1));
      }

      case "straight_line_prorate_first_last": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = addMonths(start, i);
          if (n === 1) weights.push(inclusiveDays(rawStart, end));
          else if (i === 0) weights.push(inclusiveDays(rawStart, monthEnd(rawStart)));
          else if (i === n - 1) weights.push(inclusiveDays(m, end));
          else weights.push(daysInMonth(m));
        }
        return spreadWithInitial(input, start, weights);
      }

      case "straight_line_daily": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = addMonths(start, i);
          const segStart = i === 0 ? rawStart : m;
          const segEnd = i === n - 1 ? end : monthEnd(m);
          weights.push(inclusiveDays(segStart, segEnd));
        }
        return spreadWithInitial(input, start, weights);
      }

      default:
        throw new RevenueRecognitionError("invalid recognition method");
    }
  })();

  let cumulative = 0n;
  return lines.map((l, idx) => {
    cumulative += l.units;
    return {
      sequence: idx,
      periodMonth: addMonths(l.month, periodOffset),
      planned: fromUnits(l.units),
      cumulative: fromUnits(cumulative),
    };
  });
}

// ---------------------------------------------------------------------------
// Persist a schedule (plan → recognition_schedules + lines)
// ---------------------------------------------------------------------------

/** All plan writers and posting take the contract mutex before row locks.
 * This serializes multi-obligation amendments without an obligation/contract
 * lock inversion. The key is tenant-qualified; no organization-wide lock. */
export async function lockRevenueContract(runner:SqlExecutor,orgId:string,contractId:string):Promise<void> {
  await runner.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}),hashtext(${`revenue-contract:${contractId}`}))`);
}
async function lockObligationContract(runner:SqlExecutor,orgId:string,obligationId:string):Promise<void> {
  const row=(await runner.execute<{contract_id:string}>(sql`select contract_id from performance_obligations where org_id=${orgId} and id=${obligationId}`)).rows[0];
  if(row)await lockRevenueContract(runner,orgId,row.contract_id);
}

/** Primary accounting book id (schedules are book-aware): the shared active
 * posting primary, so planning reads the same book the run posts to — never
 * a deactivated primary. */
async function primaryBookId(runner: SqlExecutor, orgId: string): Promise<string> {
  const id = await activePostingPrimaryBookId(orgId, runner);
  if (!id) throw new Error("no primary accounting book");
  return id;
}

/** Resolve the (non-adjustment) accounting period covering a date, or null. */
async function periodForDate(runner: SqlExecutor, orgId: string, date: string): Promise<string | null> {
  // Through the shared covering-period resolver: the default calendar wins
  // and overlaps resolve deterministically, instead of whichever row the
  // database happens to return first.
  return (await resolveCoveringPeriod(runner, orgId, date))?.id ?? null;
}

export interface RevenueChangeBasis {
  changeId: string; effectiveOn: string; treatment: 'separate'|'prospective'|'catch_up';
  totalAmount: string; remaining: string; targetRecognized: string; progressAtChange: string;
  creditBaseline: string; creditExposure?: CreditExposure; excludedEventIds: string[]; retired: boolean;
  deferredAccountId: string; recognizedAccountId: string; currency: string; fxRate: string; functionalCurrency:string; method:RecognitionMethod;
}

export function recognitionProgressTarget(total:string,percent:string,basis?:RevenueChangeBasis|null):string {
  pctOf(0n,percent);
  if(!basis || basis.treatment!=='prospective')return mulPercent(total,percent,4);
  const progress=toUnits(percent),baseline=toUnits(basis.progressAtChange);
  if(progress<baseline)throw new RevenueRecognitionError('progress is below the performance retained by the prospective amendment; propose a cumulative catch-up assessment before revising previously earned revenue');
  const denominator=toUnits('100')-baseline;
  const earned=denominator===0n?toUnits(basis.remaining):roundDiv(toUnits(basis.remaining)*(progress-baseline),denominator);
  return fromUnits(toUnits(basis.targetRecognized)+earned);
}

export interface BuildRecognitionResult {
  scheduleId: string;
  lineCount: number;
  /** Period months the rebuild placed no line for: already-posted periods
   * keep their postings, and zero-planned catch-up/event months carry
   * nothing. A month with no accounting period is a refusal, never a skip. */
  skippedMonths: string[];
}

/**
 * A legacy-provenance rebuild block: the obligation pins a rule whose
 * pre-upgrade history is unverified (0326), it was never reconciled (0328),
 * and it already carries schedule lines that a rebuild would destroy or
 * extend under a policy the obligation may not have been built under.
 */
export interface LegacyRebuildBlock {
  ruleId: string;
  lineCount: number;
  message: string;
}

function legacyRebuildRemedy(obligationId: string): string {
  return (
    `verify the existing schedule against the policy in force when the obligation was created, ` +
    `then reconcile the obligation with a reason via reconcileLegacyObligationProvenance ` +
    `(POST /api/revenue/obligations/${obligationId}/reconcile-legacy); the rebuild proceeds once reconciled`
  );
}

/**
 * Null when a rebuild may proceed; a block naming the remedy otherwise.
 * Shared by buildRecognitionScheduleOn (which refuses) and the project
 * revenue sync (which skips the project with a named problem instead of
 * aborting every other project), so the two predicates cannot drift.
 */
export async function legacyRebuildBlock(
  runner: SqlExecutor,
  orgId: string,
  obligationId: string,
): Promise<LegacyRebuildBlock | null> {
  const o = (await runner.execute<{
    recognition_rule_id: string;
    rule_version: number | null;
    rule_superseded_by: string | null;
    reconciled_at: string | null;
  }>(sql`
    select o.recognition_rule_id, r.version as rule_version,
           r.superseded_by as rule_superseded_by,
           o.legacy_reconciled_at::text as reconciled_at
      from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}`)).rows[0];
  if (!o) throw new Error("obligation not found");
  if (o.reconciled_at) return null;
  const legacy = await isLegacyProvenance(runner, orgId, "recognition_rules", o.recognition_rule_id, {
    // Before 0326 applies there is no registry: an unsurpassed version 1 is
    // exactly what the backfill stamps, so it stays suspect.
    fallback: o.rule_version === 1 && o.rule_superseded_by == null,
  });
  if (!legacy) return null;
  const lines = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from recognition_schedule_lines l
      join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
     where s.obligation_id = ${obligationId} and s.org_id = ${orgId}`)).rows[0];
  const lineCount = Number(lines?.n ?? "0");
  if (lineCount === 0) return null;
  return {
    ruleId: o.recognition_rule_id,
    lineCount,
    message:
      `obligation ${obligationId} pins recognition rule ${o.recognition_rule_id}, whose pre-upgrade history is ` +
      `legacy-unverified (0297): rebuilding would re-time its ${lineCount} existing schedule line(s) under a ` +
      `policy the obligation may not have been built under. ${legacyRebuildRemedy(obligationId)}`,
  };
}

export interface ObligationAttribution {
  reconciledAt: string | null;
  subsidiaryId: string | null;
}

/**
 * An obligation's entity for scope decisions: its contract's subsidiary,
 * falling back through the source line, source document and project to the
 * posting fallback root. The subsidiary leg mirrors
 * recognitionObligationScope exactly, so reconcile, preview-by-id and the
 * run/postings agree on which entity an obligation belongs to. Null when the
 * obligation is missing or cross-org. Pass forUpdate inside a writer's
 * transaction to hold the obligation row while the caller asserts scope.
 */
export async function obligationAttribution(
  runner: SqlExecutor,
  orgId: string,
  obligationId: string,
  forUpdate = false,
): Promise<ObligationAttribution | null> {
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(runner, orgId));
  const lock = forUpdate ? sql` for update of o` : sql``;
  const row = (await runner.execute<{ reconciled_at: string | null; subsidiary_id: string | null }>(sql`
    select o.legacy_reconciled_at::text as reconciled_at,
           coalesce(c.subsidiary_id, dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId}) as subsidiary_id
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      left join documents doc on doc.id = dl.document_id and doc.org_id = dl.org_id
      left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}${lock}`)).rows[0];
  return row ? { reconciledAt: row.reconciled_at, subsidiaryId: row.subsidiary_id } : null;
}

/**
 * A bare contract's entity for scope decisions: its own subsidiary, falling
 * back through its project to the posting fallback root. Null when the
 * contract is missing or cross-org.
 */
export async function revenueContractAttribution(
  runner: SqlExecutor,
  orgId: string,
  contractId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(runner, orgId));
  const row = (await runner.execute<{ subsidiary_id: string | null }>(sql`
    select coalesce(c.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId}) as subsidiary_id
      from revenue_contracts c
      left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
     where c.id = ${contractId} and c.org_id = ${orgId}`)).rows[0];
  return row ? { subsidiaryId: row.subsidiary_id } : null;
}

/**
 * Record the operator's attestation that an obligation's existing schedule
 * matches the policy actually in force at its creation, lifting the
 * legacy-rebuild refusal for that obligation only (0328). Reconciliation is
 * per obligation because one legacy rule can pin obligations built under
 * different policies — clearing the rule would re-open the still-wrong one.
 *
 * Attesting is a cross-subsidiary write: the caller's scope is REQUIRED
 * (null is the explicit unrestricted sentinel) and is asserted against the
 * obligation's entity under the obligation lock, so a concurrent rehome
 * cannot move the attestation onto another entity's obligation. A denied
 * obligation answers exactly like a missing one.
 */
export async function reconcileLegacyObligationProvenance(
  runner: SqlExecutor,
  orgId: string,
  obligationId: string,
  actorId: string | null,
  reason: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  const clean = reason.trim();
  if (clean.length < 5 || clean.length > 500) {
    throw new RevenueRecognitionError(
      "a reconciliation reason of 5 to 500 characters is required — name the evidence the existing schedule was verified against",
    );
  }
  await lockObligationContract(runner, orgId, obligationId);
  const o = await obligationAttribution(runner, orgId, obligationId, true);
  if (!o || !subsidiaryScopeAllows(allowedSubsidiaryIds, o.subsidiaryId)) throw new ScopeNotFoundError();
  const reconciledAt = o.reconciledAt;
  if (reconciledAt) {
    throw new RevenueRecognitionError("this obligation is already reconciled — its rebuild refusal is lifted");
  }
  const block = await legacyRebuildBlock(runner, orgId, obligationId);
  if (!block) {
    throw new RevenueRecognitionError(
      "nothing to reconcile: the pinned rule is not legacy-unverified, or there is no schedule evidence to verify against",
    );
  }
  // A write that matches zero rows is a failure, not a success.
  const updated = (await runner.execute<{ id: string }>(sql`
    update performance_obligations
       set legacy_reconciled_at = now(), legacy_reconciled_by = ${actorId},
           legacy_reconciliation_reason = ${clean},
           updated_at = now(), updated_by = coalesce(${actorId}, updated_by)
     where id = ${obligationId} and org_id = ${orgId}
     returning id`)).rows;
  if (updated.length !== 1) throw new Error("the reconciliation could not be recorded");
}

/**
 * (Re)build the recognition schedule for an obligation on a book from its rule
 * and resolved term. Existing UNPOSTED lines are replaced; posted lines are
 * preserved so a rebuild after some periods have recognized never disturbs
 * history. Returns the schedule id and how many lines it planned.
 *
 * percent_complete: the cumulative target is credited for what the schedule
 * has already POSTED, and the catch-up delta is planned prospectively in the
 * `asOfDate` month (a percent change is a change in estimate — ASC 250 —
 * recognized in the current period, never restated to the contract start).
 */
export async function buildRecognitionScheduleOn(
  runner: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  bookId: string,
  asOfDate?: string,
): Promise<BuildRecognitionResult> {
  await lockObligationContract(runner,orgId,obligationId);
  const oblRes = (await runner.execute<{
      id: string;
      allocated_price: string;
      status: string;
      recognition_starts_on: string | null;
      recognition_ends_on: string | null;
      percent_complete: string | null;
      contract_starts: string | null;
      contract_ends: string | null;
      method: RecognitionMethod;
      recognition_periods: number | null;
      period_offset: number;
      start_offset_days: number;
      initial_amount_percent: string;
      start_date_source: string;
      end_date_source: string;
    }>(sql`
    select o.id, o.allocated_price, o.status, o.recognition_starts_on, o.recognition_ends_on,
           o.percent_complete, c.starts_on as contract_starts, c.ends_on as contract_ends,
           r.method, r.recognition_periods, r.period_offset, r.start_offset_days,
           r.initial_amount_percent, r.start_date_source, r.end_date_source
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}
     for update of o`));
  const o = oblRes.rows[0];
  if (!o) throw new Error("obligation not found");
  if (o.status === "cancelled") throw new RevenueRecognitionError("cancelled obligations cannot be rebuilt");

  // Historical deferral rate (0256): the invoice's own rate, immutable once
  // posted, so recognition drains deferred revenue at the rate it was
  // credited at. Document-less (project) obligations measure in the
  // contract currency at par.
  const txMoney = (await runner.execute<{ tx_currency: string | null; tx_fx_rate: string | null }>(sql`
    select coalesce(d.currency, c.currency) as tx_currency,
           coalesce(d.fx_rate, 1)::text as tx_fx_rate
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      left join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}`)).rows[0];
  const txCurrency = txMoney?.tx_currency ?? undefined;
  const txFxRate = txMoney?.tx_fx_rate ?? "1";

  const startOn = o.recognition_starts_on ?? o.contract_starts;
  if (!startOn) throw new Error("obligation has no recognition start date");
  const endOn = o.recognition_ends_on ?? (o.end_date_source === "contract" ? o.contract_ends : null);

  const existing = (await runner.execute<{ id: string; revision: number; change_basis: RevenueChangeBasis | null }>(sql`
    select id,revision,change_basis from recognition_schedules
     where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`));
  const basis = existing.rows[0]?.change_basis;
  const method = basis?.method ?? o.method;
  const isPercentComplete = method === "percent_complete";
  const revision = existing.rows[0]?.revision ?? 1;
  const scheduleTotal = basis?.totalAmount ?? o.allocated_price;
  if (basis?.retired) return {scheduleId:existing.rows[0]!.id,lineCount:0,skippedMonths:[]};
  // Legacy provenance (0326/0328): a pre-versioning rule edited in place
  // cannot be trusted to re-time this obligation's existing lines. Refuse
  // before any line is destroyed; the remedy is a per-obligation
  // reconciliation, never a silent rebuild.
  const block = await legacyRebuildBlock(runner, orgId, obligationId);
  if (block) throw new RevenueRecognitionError(block.message);
  let scheduleId: string;
  if (existing.rows[0]) {
    scheduleId = existing.rows[0].id;
    await runner.execute(sql`
      update recognition_schedules
         set total_amount = ${scheduleTotal},
             transaction_currency = coalesce(transaction_currency, ${txCurrency ?? null}),
             transaction_fx_rate = coalesce(transaction_fx_rate, ${txFxRate}),
             updated_at = now(), updated_by = ${actorId}
       where id = ${scheduleId} and org_id = ${orgId}`);
    } else {
      // Concurrent replays may race on the (obligation, book) identity; lose
      // deterministically to the winner and adopt its row instead of failing.
      const ins = (await runner.execute<{ id: string }>(sql`
        insert into recognition_schedules (org_id, obligation_id, book_id, total_amount, transaction_currency, transaction_fx_rate, created_by, updated_by)
        values (${orgId}, ${obligationId}, ${bookId}, ${o.allocated_price}, ${txCurrency ?? null}, ${txFxRate}, ${actorId}, ${actorId})
        on conflict do nothing
        returning id`));
      scheduleId =
        ins.rows[0]?.id ??
        (await runner.execute<{ id: string }>(sql`
          select id from recognition_schedules
           where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`)).rows[0]!.id;
    }

  const posted = (await runner.execute<{ period_id: string; planned_amount: string; sequence: number; revision: number; modification_adjustment: boolean }>(sql`
    select period_id, case when reversal_journal_entry_id is null then coalesce(recognized_amount,0) else 0 end::text as planned_amount, sequence, revision, modification_adjustment from recognition_schedule_lines
     where org_id = ${orgId} and schedule_id = ${scheduleId} and journal_entry_id is not null`));
  const currentPosted = basis ? posted.rows.filter(r=>r.revision === revision && !r.modification_adjustment) : posted.rows;
  const postedPeriods = new Set(currentPosted.map((r) => r.period_id));
  const postedByPeriod = new Map<string, string>();
  for (const row of currentPosted) {
    postedByPeriod.set(row.period_id, add(postedByPeriod.get(row.period_id) ?? "0", row.planned_amount));
  }
  const postedToDate = sum(posted.rows.map((r) => r.planned_amount));
  const nextSequence = posted.rows.reduce((a, r) => Math.max(a, r.sequence + 1), 0);

  // Milestone and usage methods recognize from recorded events rather than
  // a term. Load the obligation's persisted events so computeRecognitionSchedule
  // produces period targets that can be compared with posted recognition.
  const isMilestoneOrUsage = method === "milestone" || method === "usage";
  let events: { periodMonth: string; amount: string }[] | undefined;
  if (isMilestoneOrUsage) {
    const eventRes = (await runner.execute<{ period_month: string; amount: string }>(sql`
      select period_month, amount from recognition_events
       where org_id = ${orgId} and obligation_id = ${obligationId}
       ${basis ? sql`and id not in (select jsonb_array_elements_text(${JSON.stringify(basis.excludedEventIds)}::jsonb)::uuid)` : sql``}
       order by period_month`));
    events = eventRes.rows.map((e) => ({ periodMonth: e.period_month, amount: e.amount }));
  }

  // Percent-complete: the catch-up delta lands in the as-of month (clamped to
  // the term start), credited for everything this schedule already posted.
  const plan = computeRecognitionSchedule({
    total: basis && !isPercentComplete ? basis.remaining : scheduleTotal,
    method,
    startOn: isPercentComplete && asOfDate && asOfDate > (basis?.effectiveOn ?? startOn) ? asOfDate : (basis?.effectiveOn ?? startOn),
    endOn,
    termPeriods: o.recognition_periods,
    startOffsetDays: basis ? 0 : o.start_offset_days,
    initialAmountPercent: basis ? '0' : o.initial_amount_percent,
    periodOffset: basis ? 0 : o.period_offset,
    percentComplete: o.percent_complete,
    alreadyRecognized: isPercentComplete ? postedToDate : null,
    events,
  });

  // For a prospective series, progress is measured over the remaining service,
  // not reapplied to revenue earned under the previous version.
  if (basis?.treatment === 'prospective' && isPercentComplete && plan[0]) {
    plan[0].planned=add(recognitionProgressTarget(scheduleTotal,o.percent_complete??'0',basis),neg(postedToDate));
  }
  await runner.execute(sql`
    delete from recognition_schedule_lines where org_id = ${orgId} and schedule_id = ${scheduleId}
     and journal_entry_id is null and superseded_by_change_id is null and not modification_adjustment`);

  // Events are immutable evidence; a period can receive more events after its
  // first posting. Plan the period's current total less its posted amount as
  // an additional line, preserving every prior posting and its sequence.
  const periodPlans: { periodId: string; periodMonth: string; planned: string; sequence: number }[] = [];
  const eventPlans = new Map<string, (typeof periodPlans)[number]>();
  const periodIds = new Map<string, string>();
  for (const p of plan) {
    const periodId = periodIds.get(p.periodMonth) ?? await periodForDate(runner, orgId, p.periodMonth);
    if (!periodId) {
      throw new RevenueRecognitionError(
        `no accounting period covers ${p.periodMonth} — provision all periods spanning the recognition term before building a schedule`,
      );
    }
    periodIds.set(p.periodMonth, periodId);
    if (isMilestoneOrUsage) {
      const prior = eventPlans.get(periodId);
      if (prior) prior.planned = add(prior.planned, p.planned);
      else {
        const pending = { periodId, periodMonth: p.periodMonth, planned: p.planned, sequence: p.sequence };
        periodPlans.push(pending);
        eventPlans.set(periodId, pending);
      }
    } else {
      periodPlans.push({ periodId, periodMonth: p.periodMonth, planned: p.planned, sequence: p.sequence });
    }
  }

  // Months the builder actually skips: already-posted periods keep their
  // lines (rebuilding never duplicates a posting), and zero-planned
  // catch-up/event months carry nothing to place. Returned alongside the
  // schedule so callers can name the gap instead of silently planning
  // nothing — the depreciation builder's skippedMonths contract.
  const skippedMonths: string[] = [];
  let lineCount = 0;
  for (const p of periodPlans) {
    const { periodId } = p;
    if (!isPercentComplete && !isMilestoneOrUsage && postedPeriods.has(periodId)) {
      skippedMonths.push(p.periodMonth);
      continue;
    }
    const planned = isMilestoneOrUsage
      ? add(p.planned, neg(postedByPeriod.get(periodId) ?? "0"))
      : p.planned;
    if ((isPercentComplete || isMilestoneOrUsage) && isZero(planned)) {
      skippedMonths.push(p.periodMonth);
      continue;
    }
    const sequence = basis || isPercentComplete || isMilestoneOrUsage ? nextSequence + lineCount : p.sequence;
    await runner.execute(sql`
      insert into recognition_schedule_lines
        (org_id, schedule_id, period_id, sequence, planned_amount, revision, created_by, updated_by)
      values (${orgId}, ${scheduleId}, ${periodId}, ${sequence}, ${planned}, ${revision}, ${actorId}, ${actorId})`);
    lineCount++;
  }
  if (lineCount > 0) {
    await runner.execute(sql`
      update recognition_schedules set status = ${posted.rows.length ? "in_progress" : "planned"},
        updated_at = now(), updated_by = ${actorId} where id = ${scheduleId} and org_id = ${orgId}`);
    await runner.execute(sql`
      update performance_obligations set status = 'open', updated_at = now(), updated_by = ${actorId}
       where id = ${obligationId} and org_id = ${orgId} and status = 'satisfied'`);
  }
  return { scheduleId, lineCount, skippedMonths };
}

/**
 * Build one obligation's recognition schedule on a book in its own transaction.
 * Callers that must keep obligations and their schedules atomic (the invoice
 * posting effect) use `buildRecognitionScheduleOn` on their transaction instead.
 */
export async function buildRecognitionSchedule(
  obligationId: string,
  orgId: string,
  actorId: string | null,
  forBookId?: string,
  asOfDate?: string,
): Promise<BuildRecognitionResult> {
  const bookId = forBookId ?? (await primaryBookId(db, orgId));
  return await db.transaction(async (tx) =>
    buildRecognitionScheduleOn(tx, obligationId, orgId, actorId, bookId, asOfDate));
}

/** Build the recognition schedule on every GL-posting book (multi-book). */
async function buildAllRecognitionSchedulesOn(
  runner: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  asOfDate?: string,
): Promise<BuildRecognitionResult[]> {
  const books = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_active and posts_gl
     order by is_primary desc, code`));
  const results: BuildRecognitionResult[] = [];
  for (const b of books.rows) {
    results.push(await buildRecognitionScheduleOn(runner, obligationId, orgId, actorId, b.id, asOfDate));
  }
  return results;
}

/** Build the recognition schedule on every GL-posting book (multi-book). */
export async function buildAllRecognitionSchedules(
  obligationId: string,
  orgId: string,
  actorId: string | null,
  asOfDate?: string,
): Promise<BuildRecognitionResult[]> {
  return db.transaction(tx => buildAllRecognitionSchedulesOn(tx, obligationId, orgId, actorId, asOfDate));
}

/**
 * Build every active GL-posting book's schedule inside one caller-supplied
 * transaction (`tx`). The multi-book percent-complete sync must be atomic:
 * a failure after the first book leaves no book changed.
 */
export async function buildAllRecognitionSchedulesInTransaction(
  tx: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  asOfDate?: string,
): Promise<BuildRecognitionResult[]> {
  return buildAllRecognitionSchedulesOn(tx, obligationId, orgId, actorId, asOfDate);
}

// ---------------------------------------------------------------------------
// recordRecognitionEvent — persist a milestone or usage event
// ---------------------------------------------------------------------------

export interface RecordRecognitionEventInput {
  obligationId: string;
  orgId: string;
  actorId: string | null;
  /** Accounting month the event belongs to (YYYY-MM-01). */
  periodMonth: string;
  /** Amount to recognize, decimal string. */
  amount: string;
  description?: string | null;
  /** Stable source identity used to make retries exactly once. */
  sourceReference: string;
  unitRate?: string | null;
  quantity?: string | null;
}

export interface RecordRecognitionEventResult {
  eventId: string;
}

/**
 * Record a milestone achievement or metered-usage occurrence for a performance
 * obligation. The event is persisted as subledger evidence and drives the next
 * schedule rebuild: the next call to buildRecognitionSchedule on the obligation
 * will load these events and plan each period's unrecognized balance.
 *
 * Corrections and amendments are additive — posting history is never rewritten.
 * A correction event with a negative amount reverses the prior recognition in
 * the affected period through the normal schedule-rebuild / posting flow.
 */
export async function recordRecognitionEvent(
  input: RecordRecognitionEventInput,
): Promise<RecordRecognitionEventResult> {
  eventMonth(input.periodMonth);
  const amount = recognitionEventDecimal(input.amount, "event amount");
  const unitRate = input.unitRate == null ? null : recognitionEventDecimal(input.unitRate, "event unit rate");
  const quantity = input.quantity == null ? null : recognitionEventDecimal(input.quantity, "event quantity");
  const sourceReference = typeof input.sourceReference === "string"
    ? input.sourceReference.trim()
    : "";
  if (!sourceReference || sourceReference.length > 500) {
    throw new RevenueRecognitionError(
      "recognition events require a non-blank sourceReference of at most 500 characters",
    );
  }

  // The event row and every book's rebuilt schedule are one atomic financial
  // unit.  If a period is missing (or any book rebuild fails), the inserted
  // event rolls back with the partial schedules and a retry can safely claim
  // the source identity again.
  return await db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);

    await lockObligationContract(tx,input.orgId,input.obligationId);
    // Validate the obligation exists and uses a milestone or usage method.
    const oblRes = (await tx.execute<{ id: string; description: string; method: string; status: string }>(sql`
      select o.id, o.description, r.method, o.status
        from performance_obligations o
        join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
       where o.id = ${input.obligationId} and o.org_id = ${input.orgId}
       for update of o`));
    if (!oblRes.rows[0]) {
      throw new RevenueRecognitionError("obligation not found");
    }
    if (oblRes.rows[0].status === "cancelled") throw new RevenueRecognitionError("cancelled obligations cannot accept recognition events");
    if (oblRes.rows[0].method !== "milestone" && oblRes.rows[0].method !== "usage") {
      throw new RevenueRecognitionError(
        `recognition method '${oblRes.rows[0].method}' does not accept events; only milestone and usage methods are supported`,
      );
    }
    // A promise retired by a prospective modification keeps its satisfied
    // status but its schedules are closed: the rebuild plans zero lines for
    // them, so an accepted event would sit in an event row that can never
    // reach the plan or the GL. Refuse by name before inserting anything.
    // Fully satisfied but NOT retired promises still accept negative
    // corrections, which reverse earned revenue through the normal rebuild.
    const schedRes = (await tx.execute<{ change_basis: RevenueChangeBasis | null }>(sql`
      select change_basis from recognition_schedules
       where obligation_id = ${input.obligationId} and org_id = ${input.orgId}`));
    const retirement = schedRes.rows
      .map((row) => row.change_basis)
      .find((basis) => basis?.retired);
    if (retirement) {
      throw new RevenueRecognitionError(
        `"${oblRes.rows[0].description}" was retired by modification ${retirement.changeId} on ${retirement.effectiveOn} — record the event against its replacement promise or amend the contract`,
      );
    }

    // The partial unique index is the concurrency authority.  A conflicting
    // transaction waits for the winner to commit, then this statement returns
    // no row and the committed event is compared below.
    const res = (await tx.execute<{ id: string }>(sql`
      insert into recognition_events
        (org_id, obligation_id, period_month, amount, description, source_reference,
         unit_rate, quantity, created_by, updated_by)
      values (${input.orgId}, ${input.obligationId}, ${input.periodMonth},
              ${amount}, ${input.description ?? null}, ${sourceReference},
              ${unitRate}, ${quantity},
              ${input.actorId}, ${input.actorId})
      on conflict (org_id, obligation_id, source_reference)
        where source_reference is not null
      do nothing
      returning id`));

    if (res.rows[0]) {
      // Rebuild the obligation's schedule on every GL-posting book so the new
      // event immediately appears as a planned recognition line.  This stays
      // on tx, so a failure rolls back both the event and all schedule writes.
      await buildAllRecognitionSchedulesOn(tx, input.obligationId, input.orgId, input.actorId);
      return { eventId: res.rows[0].id };
    }

    // A source reference may be retried with the exact same event payload,
    // which is a successful replay.  Reusing it with a different payload is a
    // fail-closed conflict: silently accepting it would make the source key's
    // financial meaning depend on whichever request won the race.
    const existing = (await tx.execute<{ id: string; payload_matches: boolean }>(sql`
      select id,
             (
               period_month = ${input.periodMonth}
               and amount = ${amount}::numeric
               and description is not distinct from ${input.description ?? null}
               and source_reference = ${sourceReference}
               and unit_rate is not distinct from ${unitRate}::numeric
               and quantity is not distinct from ${quantity}::numeric
             ) as payload_matches
        from recognition_events
       where org_id = ${input.orgId}
         and obligation_id = ${input.obligationId}
         and source_reference = ${sourceReference}
       limit 1`));
    const prior = existing.rows[0];
    if (!prior) {
      // The unique index and the read must agree.  Reaching this state means a
      // concurrent delete or a schema drift bypassed the idempotency contract;
      // do not insert a second event under the same source identity.
      throw new RevenueRecognitionError("recognition event idempotency winner was not visible");
    }
    if (!prior.payload_matches) {
      throw new RevenueRecognitionError(
        "recognition event sourceReference was already used with a different payload",
      );
    }
    return { eventId: prior.id };
  });
}

// ---------------------------------------------------------------------------
// createObligationsFromInvoice — turn a posted invoice into obligations
// ---------------------------------------------------------------------------

export interface CreateObligationsResult {
  created: number;
  contractId: string | null;
  obligationIds: string[];
}

export function revenueContractPostingEffectKey(documentId: string): string {
  return `posting-effect:revenue-contract:document:${documentId}`;
}

export function revenueObligationPostingEffectKey(documentLineId: string): string {
  return `posting-effect:revenue-obligation:document-line:${documentLineId}`;
}

/**
 * After a customer invoice posts, create one performance obligation per rev-rec
 * line (item carries a recognition rule), allocate the deferred transaction
 * price across them by relative SSP, and build their recognition schedules on
 * every GL-posting book. Runs inside the invoice post flow, and it is ATOMIC:
 * each obligation commits together with its complete schedules, so a crash or
 * a schedule-build failure can never leave committed money obligations with no
 * recognition plan. Idempotent: lines that already have an obligation are
 * never duplicated, and replay repairs obligations an earlier interrupted or
 * legacy attempt left without full per-book coverage instead of skipping them.
 *
 * SSP source per line: item.standalone_selling_price → dated fair_value_prices
 * → the booked line amount. Deferred/recognized accounts resolve item → rule.
 */
export async function createObligationsFromInvoice(
  documentId: string,
  orgId: string,
  actorId: string | null,
): Promise<CreateObligationsResult> {
  if (!(await revenueRecognitionFeatureEnabled(db, orgId))) {
    return { created: 0, contractId: null, obligationIds: [] };
  }
  const docRes = (await db.execute<{ id: string; document_number: string; party_id: string | null; currency: string | null; document_date: string; subsidiary_id: string | null }>(sql`
    select id, document_number, party_id, currency, document_date, subsidiary_id
      from documents where id = ${documentId} and org_id = ${orgId} and kind = 'customer_invoice'`));
  const doc = docRes.rows[0];
  if (!doc || !doc.party_id) return { created: 0, contractId: null, obligationIds: [] };

  // Fair-value range policy: 'warn' (default) flags out-of-range allocations
  // for review; 'off' disables the check. Configured in Company & Accounting.
  const policyRes = (await db.execute<{ policy: string }>(sql`
    select coalesce(settings->'revenue'->>'fairValueRangePolicy', 'warn') as policy
      from orgs where id = ${orgId}`));
  const rangePolicy = policyRes.rows[0]?.policy === "off" ? "off" : "warn";

  const currency = doc.currency ?? "";
  const lineRes = (await db.execute<{
      line_id: string; description: string | null; amount: string; quantity: string | null; item_id: string;
      line_custom: Record<string, unknown> | null; income_account_id: string | null; item_deferred: string | null;
      item_ssp: string | null; revenue_allocation: string; rule_id: string; rule_deferred: string | null;
      rule_recognized: string | null; end_date_source: string; fair_value: string | null;
      fair_value_low: string | null; fair_value_high: string | null;
    }>(sql`
    select dl.id as line_id, dl.description, dl.amount, dl.quantity, dl.item_id, dl.custom as line_custom,
           it.income_account_id, it.deferred_account_id as item_deferred, it.standalone_selling_price as item_ssp,
           it.revenue_allocation,
           r.id as rule_id, r.deferred_account_id as rule_deferred, r.recognized_account_id as rule_recognized,
           r.end_date_source,
           fv.unit_price as fair_value, fv.low_value as fair_value_low, fv.high_value as fair_value_high
      from document_lines dl
      join items it on it.id = dl.item_id and it.org_id = dl.org_id and it.recognition_rule_id is not null
      join recognition_rules r on r.id = it.recognition_rule_id and r.org_id = it.org_id
      left join lateral (
        select unit_price, low_value, high_value from fair_value_prices f
         where f.org_id = ${orgId} and f.item_id = dl.item_id and f.is_active
           and (f.currency = ${currency} or ${currency} = '')
           and (f.effective_from is null or f.effective_from <= ${doc.document_date})
           and (f.effective_to is null or f.effective_to >= ${doc.document_date})
         order by f.effective_from desc nulls last limit 1
      ) fv on true
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
     order by dl.line_number`));
  if (lineRes.rows.length === 0) return { created: 0, contractId: null, obligationIds: [] };

  // Lines that already produced an obligation (idempotent replay).
  const existing = (await db.execute<{ id: string; document_line_id: string; allocated_price: string }>(sql`
    select id, document_line_id, allocated_price from performance_obligations
     where org_id = ${orgId} and document_line_id = any(${`{${lineRes.rows.map((l) => l.line_id).join(",")}}`}::uuid[])`));
  const already = new Set(existing.rows.map((r) => r.document_line_id));
  const existingObligationIds = existing.rows.map((r) => r.id);
  const lines = lineRes.rows.filter((l) => !already.has(l.line_id));

  // A partial legacy replay still allocates against the WHOLE invoice bundle.
  // Existing allocations are immutable here; configuration drift must be
  // reconciled explicitly rather than silently repricing surviving obligations.
  // A complete replay skips pricing and only repairs missing schedules.
  // Lines flagged
  // 'exclude' from allocation keep their booked amount and don't dilute others.
  const included = lines.length > 0 ? lineRes.rows.filter((l) => l.revenue_allocation !== "exclude") : [];
  const bundleTotal = sum(included.map((l) => l.amount));
  const alloc = allocateByRelativeSSP(
    bundleTotal,
    included.map((l) => ({ ssp: l.item_ssp ?? l.fair_value, booked: l.amount, quantity: l.quantity })),
  );
  const allocByLine = new Map<string, string>();
  included.forEach((l, i) => allocByLine.set(l.line_id, alloc[i]!));
  for (const l of lineRes.rows) if (l.revenue_allocation === "exclude") allocByLine.set(l.line_id, l.amount);
  if (lines.length > 0 && existing.rows.some((row) => cmp(row.allocated_price, allocByLine.get(row.document_line_id)!) !== 0)) {
    throw new RevenueRecognitionError("Partial revenue allocation conflicts with existing obligations; reconcile the contract before retrying");
  }
  const contractTotal = sum(lineRes.rows.map((l) => l.amount));

  const obligationIds: string[] = [];
  const contractId = await db.transaction(async (tx) => {
    let cId: string | null = null;
    if (lines.length > 0) {
      // One contract per invoice. The unique storage key is the concurrency
      // authority; contract_number remains business display data, not a mutex.
      const contractKey = revenueContractPostingEffectKey(documentId);
      const insertedContract = await tx.execute<{ id: string }>(sql`
        insert into revenue_contracts
          (org_id, subsidiary_id, customer_id, contract_number, idempotency_key, status, starts_on,
           currency, total_transaction_price, created_by, updated_by)
        values (${orgId}, ${doc.subsidiary_id}, ${doc.party_id}, ${doc.document_number}, ${contractKey}, 'active',
                ${doc.document_date}, ${doc.currency}, ${contractTotal}, ${actorId}, ${actorId})
        on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
        returning id
      `);
      const existingContract = insertedContract.rows[0]
        ? null
        : await tx.execute<{ id: string; total_transaction_price: string }>(sql`
            select id, total_transaction_price from revenue_contracts
             where org_id=${orgId} and idempotency_key=${contractKey}
          `);
      cId = insertedContract.rows[0]?.id ?? existingContract?.rows[0]?.id ?? null;
      if (!cId) throw new Error("revenue contract idempotency winner was not visible");
      if (existingContract?.rows[0] && cmp(existingContract.rows[0].total_transaction_price, contractTotal) !== 0) {
        throw new RevenueRecognitionError("Partial revenue allocation conflicts with the existing contract total; reconcile the contract before retrying");
      }

      for (const l of lines) {
        const startsOn = (l.line_custom?.recognitionStartsOn as string) ?? doc.document_date;
        const endsOn = (l.line_custom?.recognitionEndsOn as string) ?? null;
        const deferred = l.item_deferred ?? l.rule_deferred;
        const recognized = l.rule_recognized ?? l.income_account_id;
        const allocated = allocByLine.get(l.line_id) ?? l.amount;
        const obligationKey = revenueObligationPostingEffectKey(l.line_id);
        const fvFlag = rangePolicy === "warn"
          ? fairValueRangeFlag(allocated, l.quantity, l.fair_value_low, l.fair_value_high)
          : null;
        const insObl = (await tx.execute<{ id: string }>(sql`
          insert into performance_obligations
            (org_id, contract_id, document_line_id, idempotency_key, item_id, description, recognition_rule_id,
             booked_amount, standalone_selling_price, allocated_price,
             fair_value_flag, fair_value_low, fair_value_high,
             recognition_starts_on, recognition_ends_on,
             deferred_account_id, recognized_account_id, status, created_by, updated_by)
          values (${orgId}, ${cId}, ${l.line_id}, ${obligationKey}, ${l.item_id}, ${l.description ?? "Revenue"}, ${l.rule_id},
                  ${l.amount}, ${l.item_ssp ?? l.fair_value}, ${allocated},
                  ${fvFlag}, ${fvFlag ? l.fair_value_low : null}, ${fvFlag ? l.fair_value_high : null},
                  ${startsOn}, ${endsOn}, ${deferred}, ${recognized}, 'open', ${actorId}, ${actorId})
          on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
          returning id`));
        if (insObl.rows[0]) obligationIds.push(insObl.rows[0].id);
      }

      // The schedules commit WITH the obligations they plan: a crash or a
      // schedule-build failure rolls the whole effect back, so committed money
      // obligations can never be left without their recognition schedules.
      for (const oid of obligationIds) {
        await buildAllRecognitionSchedulesOn(tx, oid, orgId, actorId);
      }
    }

    return cId;
  });

  // Replay repair: an interrupted or legacy attempt may have committed
  // obligations whose per-book coverage is incomplete. Rebuild on every active
  // GL-posting book — the builder upserts each book's plan in place (posted
  // history preserved, unposted lines replaced), so replay converges to exactly
  // one complete schedule per obligation/book with no duplicate lines.
  if (existingObligationIds.length > 0) {
    await repairMissingRecognitionSchedules(db, documentId, orgId, actorId);
  }

  return { created: obligationIds.length, contractId, obligationIds };
}

/**
 * Find open or satisfied obligations of one invoice that lack a recognition
 * schedule on at least one active GL-posting book and rebuild them. Satisfied
 * obligations are deliberately included: an obligation can only flip to
 * satisfied by scanning EXISTING schedule lines, so coverage it never received
 * could not argue for its own completion — rebuilding restores what was lost.
 * Cancelled obligations keep their cancelled lineage untouched. Returns the
 * repaired ids.
 */
async function repairMissingRecognitionSchedules(
  runner: SqlExecutor,
  documentId: string,
  orgId: string,
  actorId: string | null,
): Promise<string[]> {
  const missing = (await runner.execute<{ id: string }>(sql`
    select o.id
      from performance_obligations o
      join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
     where o.org_id = ${orgId}
       and dl.document_id = ${documentId}
       and o.status <> 'cancelled'
       and (
         select count(*)::int from recognition_schedules s
           join accounting_books b
             on b.id = s.book_id and b.org_id = s.org_id and b.is_active and b.posts_gl
          where s.obligation_id = o.id and s.org_id = o.org_id
       ) < (
         select count(*)::int from accounting_books b
          where b.org_id = ${orgId} and b.is_active and b.posts_gl
       )
     order by o.created_at`));
  const repaired: string[] = [];
  for (const row of missing.rows) {
    await buildAllRecognitionSchedulesOn(runner, row.id, orgId, actorId);
    repaired.push(row.id);
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// runRevenueRecognition — post due periods through the kernel
// ---------------------------------------------------------------------------

export interface RevenueRecognitionEntryIdentity {
  contractNumber: string;
  periodName: string;
  obligationId: string;
  bookId: string;
  sequence: number;
  lineId: string;
}

/**
 * Stable identity for one recognition journal in the organization-wide entry
 * number namespace. Full source ids are deliberate: one contract can carry
 * several obligations, every obligation can have a schedule on several books,
 * and percent-complete schedules can post several lines in one period.
 */
export function revenueRecognitionEntryNumber(
  identity: RevenueRecognitionEntryIdentity,
): string {
  return [
    "REV",
    identity.contractNumber,
    identity.periodName,
    identity.obligationId,
    identity.bookId,
    identity.sequence,
    identity.lineId,
  ].join("-");
}

export interface RunRecognitionResult {
  posted: number;
  skipped: number;
  totalAmount: string;
  entries: { contract: string; obligation: string; period: string; amount: string; entryId: string }[];
  problems: string[];
}

/**
 * What remains genuinely unearned for one obligation on one book (F-w5-001).
 *
 *   remaining = allocated − recognized(net of reversals) − credited-to-deferred
 *
 * `credited-to-deferred` counts only posted, non-voided customer-credit lines
 * that debit the obligation's own deferred account, on a credit with a live
 * application to the source invoice. That conjunction is the whole rule:
 *
 * - deferred-account scoping is what separates unearned relief (retires the
 *   plan) from an income-account concession (reduces earned, plan untouched);
 * - the application is the only structural edge a credit memo has to an
 *   invoice, so an unapplied credit cannot be attributed to any obligation;
 * - voided credits are excluded by document status, and their reversal
 *   entries never match because only the document's own posted entry counts.
 *
 * Obligations with no source invoice (project percent-complete) correlate to
 * nothing and always report zero credits. Recognized amounts and amendment
 * allocations stay book-specific; the invoice's settled credits are shared.
 */
export async function recognitionUnearnedRemaining(
 tx:SqlExecutor,input:{orgId:string;obligationId:string;bookId:string;deferredAccountId:string},
):Promise<{remaining:string;credited:string;exposure:CreditExposure}> {
 const row=(await tx.execute<{allocated:string;recognized:string;change_basis:RevenueChangeBasis|null;invoice_id:string|null;currency:string|null;tx_fx_rate:string|null}>(sql`
 select coalesce(s.total_amount,o.allocated_price)::text as allocated,s.change_basis,inv.id as invoice_id,inv.currency,s.transaction_fx_rate::text as tx_fx_rate,
   coalesce((select sum(case when l.journal_entry_id is not null and l.reversal_journal_entry_id is null then coalesce(l.recognized_amount,0) else 0 end)
     from recognition_schedule_lines l where l.org_id=o.org_id and l.schedule_id=s.id),0)::text as recognized
 from performance_obligations o left join recognition_schedules s on s.obligation_id=o.id and s.org_id=o.org_id and s.book_id=${input.bookId}
 left join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id
 left join documents inv on inv.id=dl.document_id and inv.org_id=dl.org_id
 where o.org_id=${input.orgId} and o.id=${input.obligationId}`)).rows[0];
 if(!row)throw new RevenueRecognitionError('recognition obligation disappeared during posting');
 let exposure:CreditExposure=row.change_basis?.creditExposure??{kind:'none'};
 if(!row.change_basis?.creditExposure && row.invoice_id && row.currency) {
   const peers=(await tx.execute<{id:string;weight:string}>(sql`select o.id,coalesce(o.booked_amount,o.allocated_price)::text as weight
    from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id
    left join items i on i.id=o.item_id and i.org_id=o.org_id join recognition_rules r on r.id=o.recognition_rule_id and r.org_id=o.org_id
    where o.org_id=${input.orgId} and dl.document_id=${row.invoice_id} and coalesce(o.deferred_account_id,i.deferred_account_id,r.deferred_account_id)=${input.deferredAccountId} order by o.id`)).rows;
   const index=peers.findIndex(p=>p.id===input.obligationId);
   if(index<0)throw new RevenueRecognitionError('the invoice credit allocation omitted this promise');
   // The credit pool measures in transaction units, but the evidence names
   // the historical deferral rate (0256), not a defaulted 1.
   exposure={kind:'invoice',source:{invoiceId:row.invoice_id,deferredAccountId:input.deferredAccountId,baseline:'0',currency:row.currency,fxRate:row.tx_fx_rate ?? '1'},weights:peers.map(p=>p.weight),index};
 }
 const credited=await measureCreditExposure(tx,input.orgId,input.bookId,exposure);
 return {remaining:sum([row.allocated,neg(row.recognized),neg(credited)]),credited,exposure};
}

/**
 * Cumulative net earned for one obligation on one book: posted recognition
 * less historical reversals. Uses the same canonical predicate as the
 * unearned-remaining helper and the schedule rebuild — a line counts only
 * once its journal is posted, and a line carrying a reversal journal never
 * counts (the compensating reversal journal unwinds the ledger; counting the
 * original too would double-count earned). Unposted plan lines never count.
 */
async function recognitionNetRecognized(
 tx:SqlExecutor,input:{orgId:string;obligationId:string;bookId:string},
):Promise<string> {
 const row=(await tx.execute<{net:string}>(sql`
  select coalesce((select sum(case when l.journal_entry_id is not null and l.reversal_journal_entry_id is null then coalesce(l.recognized_amount,0) else 0 end)
    from recognition_schedule_lines l
    join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
   where l.org_id=${input.orgId} and s.obligation_id=${input.obligationId} and s.book_id=${input.bookId}),0)::text as net`)).rows[0];
 return row?.net ?? "0";
}

function recognitionObligationScope(orgId: string, allowedSubsidiaryIds: readonly string[] | undefined, fallbackSubsidiaryId: string) {
  if (allowedSubsidiaryIds === undefined) return sql`true`;
  // Unattributed obligations fall back to the shared unscoped-posting
  // default (the hierarchy root), resolved once by the caller — never the
  // oldest subsidiary.
  return sql`exists (
    select 1 from revenue_contracts scoped_contract
      left join document_lines scoped_line on scoped_line.id = o.document_line_id and scoped_line.org_id = o.org_id
      left join documents scoped_document on scoped_document.id = scoped_line.document_id and scoped_document.org_id = o.org_id
      left join projects scoped_project on scoped_project.id = scoped_contract.project_id and scoped_project.org_id = o.org_id
     where scoped_contract.id = o.contract_id and scoped_contract.org_id = o.org_id
       and coalesce(scoped_contract.subsidiary_id, scoped_line.subsidiary_id, scoped_document.subsidiary_id, scoped_project.subsidiary_id,
         ${fallbackSubsidiaryId})
         = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])
  )`;
}

type RecognitionPostingRow = {
  recognition_on: string | null; recognition_currency: string | null; functional_currency:string|null; recognition_fx_rate: string;
  line_id: string; planned: string; period_id: string; sequence: number;
  book_id: string; period_name: string; period_ends_on: string;
  method: RecognitionMethod;
  obligation_id: string; obligation_desc: string; contract_number: string;
  obl_deferred: string | null; obl_recognized: string | null;
  item_deferred: string | null; item_income: string | null;
  rule_deferred: string | null; rule_recognized: string | null;
  subsidiary_id: string | null; base_currency: string | null;
  department_id: string | null; project_id: string | null;
  location_id: string | null; class_id: string | null;
  equipment_unit_id: string | null; extra_dims: Record<string, unknown>;
};

/** Discovery is advisory. The posting transaction reloads this same projection
 * after owning the obligation, while locking the line and its native policy.
 */
async function recognitionPostingRows(
  runner: SqlExecutor,
  orgId: string,
  asOfDate: string,
  fallbackSubsidiaryId: string,
  obligationId?: string,
  allowedSubsidiaryIds?: string[],
  lineId?: string,
  claim = false,
): Promise<RecognitionPostingRow[]> {
  const obligationScope = recognitionObligationScope(orgId, allowedSubsidiaryIds, fallbackSubsidiaryId);
  return (await runner.execute<RecognitionPostingRow>(sql`
    select l.id             as line_id,
           l.recognition_on::text as recognition_on,
           coalesce(s.change_basis->>'currency',s.transaction_currency) as recognition_currency,
           s.change_basis->>'functionalCurrency' as functional_currency,
           coalesce(s.change_basis->>'fxRate',s.transaction_fx_rate::text,'1') as recognition_fx_rate,
           l.planned_amount as planned,
           l.period_id      as period_id,
           l.sequence       as sequence,
           s.book_id        as book_id,
           p.name           as period_name,
           p.ends_on        as period_ends_on,
           coalesce(s.change_basis->>'method',r.method) as method,
           o.id             as obligation_id,
           o.description    as obligation_desc,
           coalesce((s.change_basis->>'deferredAccountId')::uuid,o.deferred_account_id) as obl_deferred,
           coalesce((s.change_basis->>'recognizedAccountId')::uuid,o.recognized_account_id) as obl_recognized,
           it.deferred_account_id   as item_deferred,
           it.income_account_id     as item_income,
           r.deferred_account_id    as rule_deferred,
           r.recognized_account_id  as rule_recognized,
           c.contract_number as contract_number,
           coalesce(c.subsidiary_id, dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, fsub.id) as subsidiary_id,
           coalesce(sub.base_currency, psub.base_currency, fsub.base_currency) as base_currency,
           coalesce(dl.department_id, doc.department_id) as department_id,
           coalesce(dl.project_id, doc.project_id, c.project_id) as project_id,
           coalesce(dl.location_id, doc.location_id) as location_id,
           coalesce(dl.class_id, doc.class_id) as class_id,
           dl.equipment_unit_id as equipment_unit_id,
           coalesce(doc.extra_dims, '{}'::jsonb)
             || coalesce(dl.extra_dims, '{}'::jsonb) as extra_dims
      from recognition_schedule_lines l
      join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.posts_gl and bk.is_active
      join performance_obligations o on o.id = s.obligation_id and o.org_id = s.org_id
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
      left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      left join documents doc on doc.id = dl.document_id and doc.org_id = dl.org_id
      left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
      left join items it on it.id = o.item_id and it.org_id = o.org_id
      left join subsidiaries sub on sub.id = coalesce(c.subsidiary_id, dl.subsidiary_id, doc.subsidiary_id) and sub.org_id = o.org_id
      left join subsidiaries psub on psub.id = prj.subsidiary_id and psub.org_id = prj.org_id
      left join lateral (
        select id, base_currency from subsidiaries where org_id = ${orgId} and id = ${fallbackSubsidiaryId}
      ) fsub on true
     where l.org_id = ${orgId}
       and l.journal_entry_id is null and l.superseded_by_change_id is null
       and o.status <> 'cancelled'
       and (s.change_basis is not null or not r.is_forecast)
       -- Scheduled methods recognize a period once it has ENDED; percent_complete
       -- is a measurement AS OF the date, so its catch-up in the current period
       -- is due as soon as the period has started.
       and (case when l.recognition_on is not null then l.recognition_on <= ${asOfDate}::date else (p.ends_on <= ${asOfDate}
            or (coalesce(s.change_basis->>'method',r.method) = 'percent_complete' and p.starts_on <= ${asOfDate})) end)
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and ${obligationScope}
       ${lineId ? sql`and l.id = ${lineId}` : sql``}
     order by c.contract_number, o.description, l.sequence
     ${claim ? sql`for update of l for share of s, bk, c, r, p` : sql``}`)).rows;
}

/**
 * A confirmed run whose reviewed set no longer matches live state. The route
 * maps this to 409 stale_preview — preview again, then confirm. Never a
 * partial post: this is raised before the first write.
 */
export class StaleRecognitionPreviewError extends Error {}

/**
 * The reviewed-run fence, in one place.
 *
 * When `confirm` is supplied, the exact reviewed set is re-derived and
 * compared BEFORE anything posts: a changed amount, account, period, entity
 * or membership aborts the whole run (StaleRecognitionPreviewError) with zero
 * writes, and only the reviewed lines are considered afterwards.
 *
 * It is a pre-flight fence, not one transaction: each line still posts in its
 * own transaction, so a failure part-way through leaves the lines already
 * posted (each individually balanced and linked to its plan). What it removes
 * is the silent case — posting something the operator never reviewed, or
 * skipping something they did.
 */

/**
 * Post every due, unposted recognition line whose period ends on or before
 * `asOfDate`. Each line becomes one balanced journal entry (DR deferred / CR
 * recognized) posted through the kernel, origin = 'revenue_recognition'. A
 * closed GL period is skipped (not an error). Idempotent: a line with a
 * journal_entry_id is never reconsidered. Every posting is capped at what
 * remains genuinely unearned for its obligation (F-w5-001): a fully-credited
 * obligation holds its plan lines (skipped with an explanatory problem), a
 * partially-credited one posts only the remainder.
 */
export async function runRevenueRecognition(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  obligationId?: string,
  allowedSubsidiaryIds?: string[],
  confirm?: { fingerprint: string; scope: RecognitionPreviewInput },
): Promise<RunRecognitionResult> {
  recognitionDate(asOfDate, "recognition as-of date");
  await assertEnabled(db, orgId);
  // Unattributed obligations default to the hierarchy root through the
  // shared resolver — never the oldest subsidiary.
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const obligationScope = recognitionObligationScope(orgId, allowedSubsidiaryIds, fallbackSubsidiaryId);

  const effectiveMethod=sql`coalesce((select s.change_basis->>'method' from recognition_schedules s join accounting_books b on b.id=s.book_id and b.org_id=s.org_id and b.is_primary and b.is_active and b.posts_gl where s.obligation_id=o.id and s.org_id=o.org_id limit 1),r.method)`;

  let confirmedLineIds: Set<string> | null = null;
  if (confirm) {
    const current = await previewRevenueRecognition(orgId, confirm.scope);
    if (current.fingerprint !== confirm.fingerprint) {
      throw new StaleRecognitionPreviewError(
        "the reviewed set changed; preview again before confirming",
      );
    }
    confirmedLineIds = new Set(
      current.rows.filter((row) => row.skipReason === null).map((row) => row.lineId),
    );
    if (confirmedLineIds.size === 0) return { posted: 0, skipped: 0, totalAmount: "0", entries: [], problems: [] };
  }

  const due = (await recognitionPostingRows(db, orgId, asOfDate, fallbackSubsidiaryId, obligationId, allowedSubsidiaryIds))
    .filter((row) => confirmedLineIds === null || confirmedLineIds.has(row.line_id));

  const result: RunRecognitionResult = { posted: 0, skipped: 0, totalAmount: "0", entries: [], problems: [] };

  for (const candidate of due) {
    try {
      const posted = await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
        await lockObligationContract(tx,orgId,candidate.obligation_id);
        // Rebuilds, event writes and cancellation share this aggregate lock.
        // Nothing from the preliminary scan is a financial posting input.
        const obligation = await tx.execute<{ id: string }>(sql`
          select o.id from performance_obligations o
           where o.org_id = ${orgId} and o.id = ${candidate.obligation_id}
           for update of o`);
        if (!obligation.rows[0]) return { status: "already_posted" as const };
        await assertEnabled(tx, orgId);
        const row = (await recognitionPostingRows(
          tx, orgId, asOfDate, fallbackSubsidiaryId, candidate.obligation_id, allowedSubsidiaryIds,
          candidate.line_id, true,
        ))[0];
        if (!row) return { status: "already_posted" as const };
        // One period gate: the shared GL check replaces the raw
        // period_module_is_closed projection. Discovery stays advisory — a
        // closed line is skipped, not fatal — and source-owned imported
        // locks skip exactly like user locks.
        if (!(await arePeriodModulesOpen(tx, {
          orgId,
          periodId: row.period_id,
          bookId: row.book_id,
          subsidiaryIds: row.subsidiary_id ? [row.subsidiary_id] : [],
          modules: ["gl"],
        }))) return { status: "period_closed" as const };
        const planned = row.planned;
        if (isZero(planned)) {
          await tx.execute(sql`
            update recognition_schedule_lines set recognized_amount = '0',
                   updated_at = now(), updated_by = ${actorId}
             where id = ${row.line_id} and org_id = ${orgId} and journal_entry_id is null`);
          return { status: "zero" as const };
        }
        const deferredAccountId = row.obl_deferred ?? row.item_deferred ?? row.rule_deferred;
        const recognizedAccountId = row.obl_recognized ?? row.rule_recognized ?? row.item_income;
        if (!deferredAccountId || !recognizedAccountId) {
          return { status: "not_configured" as const, row };
        }
        // F-w5-001: a manual credit memo relieves deferred without touching
        // the plan. Never post more than what remains genuinely unearned; a
        // fully-credited obligation holds its plan lines, a partially-credited
        // one posts only the remainder (the final line may post partial).
        // A negative plan line is a same-period correction that reduces earned
        // revenue — it can never breach the unearned ceiling, so the cap
        // constrains positive postings only. Capping a correction at an
        // exhausted remainder would silently drop legitimate evidence.
        const cap = await recognitionUnearnedRemaining(tx, {
          orgId, obligationId: row.obligation_id, bookId: row.book_id, deferredAccountId,
        });
        let posting = planned;
        if (cmp(planned, "0") > 0) {
          if (cmp(cap.remaining, "0") <= 0) {
            return { status: "credit_capped" as const, credited: cap.credited, row };
          }
          posting = cmp(planned, cap.remaining) > 0 ? cap.remaining : planned;
        } else if (cmp(planned, "0") < 0) {
          // A negative plan line is a correction reversing earned revenue. It
          // can never drive cumulative net earned negative on its book: with
          // nothing (or too little) earned, the correction reverses unearned
          // revenue that was never recognized. Hold the whole line unposted
          // with an explanatory problem — never floor it at zero, which would
          // silently drop the operator's evidence. The unearned cap above
          // constrains positive postings only, so an exhausted remainder never
          // blocks a legitimate negative.
          const net = await recognitionNetRecognized(tx, {
            orgId, obligationId: row.obligation_id, bookId: row.book_id,
          });
          if (cmp(add(net, planned), "0") < 0) {
            return { status: "negative_floor" as const, net, planned, row };
          }
        }
        if (!row.subsidiary_id || !row.base_currency) {
          throw new RevenueRecognitionError("recognition legal entity and functional currency are required");
        }
        if(row.functional_currency && row.functional_currency!==row.base_currency) throw new RevenueRecognitionError("complete the legal entity functional-currency transition before posting this amended contract");
        const subsidiaryId = row.subsidiary_id;
        // Hold the legal-entity tree while validating the current account and
        // dimension restrictions; discovery-time validation is not sufficient.
        await tx.execute(sql`select id from subsidiaries where org_id = ${orgId} order by id for share`);
        const subsidiaryContext = await loadSubsidiaryContext(tx, orgId);
        const basePosting = mulRate(posting, row.recognition_fx_rate);
        const lines = [
          { accountId: deferredAccountId, amount: basePosting, txnAmount: posting },
          { accountId: recognizedAccountId, amount: neg(basePosting), txnAmount: neg(posting) },
        ];
        await validateSubsidiaryRestrictions(tx, {
          orgId, ctx: subsidiaryContext, docSubsidiaryId: subsidiaryId,
          lines: lines.map(line => ({
            ...line, subsidiaryId,
            departmentId: row.department_id, projectId: row.project_id,
            locationId: row.location_id, classId: row.class_id,
          })),
        });
        const balance = sum(lines.map(line => line.amount));
        if (!isZero(balance)) throw new RevenueRecognitionError(`unbalanced (${balance})`);
        const postingDate = row.recognition_on ?? (row.method === "percent_complete" && asOfDate < row.period_ends_on
          ? asOfDate : row.period_ends_on);
        const entryRes = (await tx.execute<{ id: string }>(sql`
          insert into journal_entries
            (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${orgId}, ${row.book_id}, ${row.subsidiary_id},
                  ${revenueRecognitionEntryNumber({
                    contractNumber: row.contract_number,
                    periodName: row.period_name,
                    obligationId: row.obligation_id,
                    bookId: row.book_id,
                    sequence: row.sequence,
                    lineId: row.line_id,
                  })},
                  ${postingDate}, ${row.period_id},
                  ${`Revenue recognition — ${row.obligation_desc} (${row.period_name})`},
                  'draft', 'revenue_recognition', ${actorId}, ${actorId})
          returning id`));
        const eid = entryRes.rows[0]!.id;

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i]!;
          await tx.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
               department_id, project_id, location_id, class_id, equipment_unit_id, extra_dims, memo)
            values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${row.subsidiary_id}, ${l.amount}, ${row.recognition_currency ?? row.base_currency}, ${l.txnAmount}, ${row.recognition_fx_rate},
                    ${row.department_id}, ${row.project_id}, ${row.location_id}, ${row.class_id},
                    ${row.equipment_unit_id}, ${JSON.stringify(row.extra_dims ?? {})}::jsonb,
                    ${`Revenue recognition ${row.period_name}`})`);
        }

        const committed=await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${eid} and org_id = ${orgId} and status='draft' returning id`);
        if(committed.rows.length!==1)throw new RevenueRecognitionError('recognition journal could not be posted');
        const linked=await tx.execute(sql`
          update recognition_schedule_lines
             set recognized_amount = ${posting}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id} and org_id = ${orgId} and journal_entry_id is null and superseded_by_change_id is null returning id`);
        if(linked.rows.length!==1)throw new RevenueRecognitionError('recognition journal could not be linked to its plan');
        return { status: "posted" as const, entryId: eid, planned: posting, row };
      }));
      if (posted.status === "already_posted" || posted.status === "zero") {
        result.skipped++;
        continue;
      }
      if (posted.status === "credit_capped") {
        result.skipped++;
        result.problems.push(
          `${posted.row.contract_number} ${posted.row.obligation_desc}: fully credited — ${posted.credited} relieved to deferred, nothing remains unearned; plan line held`,
        );
        continue;
      }
      if (posted.status === "negative_floor") {
        result.skipped++;
        result.problems.push(
          `${posted.row.contract_number} ${posted.row.obligation_desc}: correction of ${posted.planned} exceeds the ${posted.net} recognized to date — held unposted; record an offsetting recognition event for the excess (events are additive, so the offset replans the held line into a valid correction)`,
        );
        continue;
      }
      if (posted.status === "not_configured") {
        result.skipped++;
        result.problems.push(`${posted.row.contract_number} ${posted.row.obligation_desc}: deferred/recognized account not configured`);
        continue;
      }
      if (posted.status === "period_closed") {
        result.skipped++;
        result.problems.push(`${candidate.contract_number} ${candidate.period_name}: GL period closed`);
        continue;
      }
      result.posted++;
      result.totalAmount = add(result.totalAmount, recognitionBaseAmount(posted.planned, posted.row.recognition_fx_rate));
      result.entries.push({
        contract: posted.row.contract_number,
        obligation: posted.row.obligation_desc,
        period: posted.row.period_name,
        amount: posted.planned,
        entryId: posted.entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${candidate.contract_number} ${candidate.period_name}: ${msg.slice(0, 120)}`);
    }
  }

  // Milestone/usage plans come from explicitly recorded events. A schedule
  // built with none carries zero lines: nothing ever posts, nothing ever
  // satisfies, and the invoiced amount sits parked in deferred revenue
  // indefinitely. Surface the gap instead of skipping it silently.
  const emptyPlans = (await db.execute<{ contract_number: string; description: string }>(sql`
    select c.contract_number, o.description
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.org_id = ${orgId} and o.status = 'open'
       and (not r.is_forecast or o.last_change_id is not null) and ${obligationScope}
       and ${effectiveMethod} in ('milestone', 'usage')
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and (
         not exists (select 1 from recognition_schedules s where s.obligation_id = o.id and s.org_id = o.org_id)
         or (
           exists (select 1 from recognition_schedules s where s.obligation_id = o.id and s.org_id = o.org_id)
           and not exists (
             select 1 from recognition_schedule_lines l
               join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
              where s.obligation_id = o.id and s.org_id = o.org_id and l.superseded_by_change_id is null)
         )
       )`));
  for (const row of emptyPlans.rows) {
    result.problems.push(
      `${row.contract_number} ${row.description}: milestone/usage obligation has no recognition events recorded`,
    );
  }

  // Flip fully-recognized obligations to 'satisfied' (no unposted non-zero lines
  // left). Percent-complete obligations are the exception: "caught up to the
  // current estimate" is not "done" — they satisfy only at 100% complete, so an
  // ongoing project contract stays open between catch-ups. The flip also
  // demands positive evidence of completion — at least one schedule line — so a
  // zero-line schedule (e.g. milestone/usage with no events recorded) can never
  // vacuously satisfy an obligation with nothing recognized.
  await db.execute(sql`
    update performance_obligations o
       set status = 'satisfied', updated_at = now()
      from recognition_rules r
     where r.id = o.recognition_rule_id
       and r.org_id = o.org_id
       and o.org_id = ${orgId} and o.status = 'open'
       and (not r.is_forecast or o.last_change_id is not null) and ${obligationScope}
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and (${effectiveMethod} <> 'percent_complete' or coalesce(o.percent_complete, '0')::numeric >= 100)
       and (${effectiveMethod} not in ('milestone', 'usage') or not exists (
         select 1 from recognition_schedules event_schedule
          where event_schedule.org_id = o.org_id and event_schedule.obligation_id = o.id
            and coalesce((select sum(event_line.recognized_amount)
              from recognition_schedule_lines event_line
              where event_line.org_id = o.org_id and event_line.schedule_id = event_schedule.id
                and event_line.journal_entry_id is not null), 0) <> event_schedule.total_amount
       ))
       and exists (
         select 1 from recognition_schedule_lines l
           join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
          where s.obligation_id = o.id and s.org_id = o.org_id)
       and not exists (
         select 1 from recognition_schedules s
           join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
          where s.obligation_id = o.id and s.org_id = o.org_id and l.journal_entry_id is null and l.superseded_by_change_id is null and l.planned_amount <> '0')`);

  // Advance schedule status for reporting.
  await db.execute(sql`
    update recognition_schedules s set status = case
        when not exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is null and l.superseded_by_change_id is null and l.planned_amount <> '0') then 'complete'
        when exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is not null) then 'in_progress'
        else 'planned' end,
      updated_at = now()
    from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
    where s.org_id = ${orgId} and s.obligation_id = o.id and s.org_id = o.org_id
      and o.status <> 'cancelled' and (not r.is_forecast or o.last_change_id is not null) and ${obligationScope}
      ${obligationId ? sql`and s.obligation_id = ${obligationId}` : sql``}`);

  return result;
}

// ---------------------------------------------------------------------------
// Controlled invoice cancellation
// ---------------------------------------------------------------------------

export class RevenueRecognitionCancellationError extends Error {}

export interface CancelRevenueRecognitionResult {
  status: "cancelled" | "pending_approval";
  recognitionReversalEntryIds: string[];
  invoiceReversalEntryId: string | null;
  runId: string | null;
}

function cancellationReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new RevenueRecognitionCancellationError(
      "a cancellation reason between 5 and 500 characters is required",
    );
  }
  return reason;
}

function cancellationDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw new RevenueRecognitionCancellationError(
      "reversalDate must be a valid YYYY-MM-DD date",
    );
  }
  return value;
}

/**
 * Cancel all revenue-recognition activity sourced by an invoice, then route the
 * invoice through the normal controlled-void workflow.
 *
 * Posted recognition journals are never edited or detached. Each receives one
 * exact, row-locked compensating journal and the schedule line stores both ids.
 * Unposted schedule lines remain as historical plan evidence but are made
 * ineligible by the cancelled obligation. Retries and concurrent callers return
 * the same lineage.
 */
export async function cancelRevenueRecognitionForInvoice(input: {
  documentId: string;
  orgId: string;
  actorId: string;
  reason: string;
  reversalDate: string;
  /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<CancelRevenueRecognitionResult> {
  if (!input.actorId) {
    throw new RevenueRecognitionCancellationError(
      "an attributable actor is required",
    );
  }
  const reason = cancellationReason(input.reason);
  const reversalDate = cancellationDate(input.reversalDate);

  // Keep the recognition reversals and the invoice's controlled-void request
  // in one transaction. A void can fail after its request is claimed (for
  // example, because a downstream transaction or a closed subledger period
  // blocks the final reversal). Calling the void path after this transaction
  // commits would leave the recognition lineage cancelled while the invoice
  // remains posted. The org transaction boundary is reused by the document
  // void helpers, so every effect rolls back together on any failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withOrg(input.orgId, () =>
        db.transaction(async (tx) => {
      const document = (await tx.execute<{
        id: string;
        status: string;
        subsidiary_id: string | null;
        reversal_entry_id: string | null;
        void_requested_at: Date | null;
      }>(sql`
        select id, status, subsidiary_id, reversal_entry_id, void_requested_at
          from documents
         where id = ${input.documentId}
           and org_id = ${input.orgId}
           and kind = 'customer_invoice'
         for update
      `));
      const doc = document.rows[0];
      // Scope is rechecked under the invoice lock: the route's unlocked
      // pre-read can authorize entity A while a concurrent A→B rehome lands
      // before this cancel commits. Missing and out-of-scope answer alike.
      if (!doc || !subsidiaryScopeAllows(input.allowedSubsidiaryIds, doc.subsidiary_id)) {
        throw new ScopeNotFoundError();
      }
      if (!["posted", "voided"].includes(doc.status)) {
        throw new RevenueRecognitionCancellationError(
          `customer invoice is ${doc.status}; only a posted invoice can be cancelled`,
        );
      }

      const affectedContracts=(await tx.execute<{contract_id:string}>(sql`select distinct o.contract_id from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id where o.org_id=${input.orgId} and dl.document_id=${input.documentId} order by o.contract_id`)).rows;
      for(const c of affectedContracts)await lockRevenueContract(tx,input.orgId,c.contract_id);
      const obligations = (await tx.execute<{ id: string; contract_id: string; status: string }>(sql`
        select obligation.id, obligation.contract_id, obligation.status
          from performance_obligations obligation
         where obligation.org_id = ${input.orgId}
           and obligation.contract_id in(select jsonb_array_elements_text(${JSON.stringify(affectedContracts.map(c=>c.contract_id))}::jsonb)::uuid)
         order by obligation.id
         for update of obligation
      `));
      if (obligations.rows.length === 0) {
        throw new RevenueRecognitionCancellationError(
          "invoice has no revenue-recognition obligations",
        );
      }

      const obligationIds = obligations.rows.map((row) => row.id);
      const sources = (await tx.execute<{
          line_id: string;
          journal_entry_id: string;
          reversal_journal_entry_id: string | null;
          entry_number: string;
          book_id: string;
          subsidiary_id: string;
          entry_status: string;
        }>(sql`
        select schedule_line.id as line_id,
               schedule_line.journal_entry_id,
               schedule_line.reversal_journal_entry_id,
               entry.entry_number,
               entry.book_id,
               entry.subsidiary_id,
               entry.status as entry_status
          from recognition_schedule_lines schedule_line
          join recognition_schedules schedule
            on schedule.id = schedule_line.schedule_id
           and schedule.org_id = schedule_line.org_id
          join journal_entries entry
            on entry.id = schedule_line.journal_entry_id
           and entry.org_id = schedule_line.org_id
         where schedule_line.org_id = ${input.orgId}
           and schedule.obligation_id =
             any(${`{${obligationIds.join(",")}}`}::uuid[])
         order by schedule_line.created_at, schedule_line.id
         for update of schedule_line, entry
      `));

      const reversalIds: string[] = [];
      for (const source of sources.rows) {
        if (source.reversal_journal_entry_id) {
          reversalIds.push(source.reversal_journal_entry_id);
          continue;
        }
        if (source.entry_status !== "posted") {
          throw new RevenueRecognitionCancellationError(
            `${source.entry_number} is ${source.entry_status} without recorded cancellation lineage`,
          );
        }
        const period = (await tx.execute<{ id: string }>(sql`
          select period.id
            from accounting_periods period
           where period.org_id = ${input.orgId}
             and period.starts_on <= ${reversalDate}
             and period.ends_on >= ${reversalDate}
           order by period.is_adjustment, period.starts_on
           limit 1
        `));
        if (!period.rows[0]) {
          throw new RevenueRecognitionCancellationError(
            `no accounting period covers ${reversalDate}`,
          );
        }
        // One period gate: the shared GL check replaces the raw
        // period_module_is_closed predicate. A reversal is new activity, not
        // historical replay, so source-owned imported locks refuse exactly
        // like user locks.
        try {
          await assertPeriodModulesOpen(tx, {
            orgId: input.orgId,
            periodId: period.rows[0].id,
            bookId: source.book_id,
            subsidiaryIds: [source.subsidiary_id],
            modules: ["gl"],
          });
        } catch (error) {
          if (error instanceof CloseError) {
            throw new RevenueRecognitionCancellationError(
              `the GL period covering ${reversalDate} is closed`,
            );
          }
          throw error;
        }

        const inserted = (await tx.execute<{ id: string }>(sql`
          insert into journal_entries
            (org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin, reverses_entry_id,
             created_by, updated_by)
          values
            (${input.orgId}, ${source.book_id}, ${source.subsidiary_id},
             ${`${source.entry_number}-CANCEL`}, ${reversalDate},
             ${period.rows[0].id}, ${`Revenue recognition cancellation — ${reason}`},
             'draft', 'revenue_recognition', ${source.journal_entry_id},
             ${input.actorId}, ${input.actorId})
          returning id
        `));
        const reversalId = inserted.rows[0]!.id;

        await tx.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
             currency, txn_amount, fx_rate, memo, party_id, department_id,
             project_id, location_id, class_id, equipment_unit_id,
             payment_card_id, extra_dims, tax_code_id, quantity, unit,
             due_date, is_open_item, custom)
          select org_id, ${reversalId}, line_number, account_id, subsidiary_id,
                 -amount, currency, -txn_amount, fx_rate,
                 ${`Revenue recognition cancellation — ${reason}`},
                 party_id, department_id, project_id, location_id, class_id,
                 equipment_unit_id, payment_card_id, extra_dims, tax_code_id,
                 case when quantity is null then null else -quantity end,
                 unit, null, false, custom
            from journal_lines
           where entry_id = ${source.journal_entry_id} and org_id = ${input.orgId}
           order by line_number
        `);
        await tx.execute(sql`
          update journal_entries
             set status = 'posted', posted_at = now(),
                 posted_by = ${input.actorId}, updated_at = now(),
                 updated_by = ${input.actorId}
           where id = ${reversalId} and org_id = ${input.orgId}
        `);
        await tx.execute(sql`
          update journal_entries
             set status = 'reversed', updated_at = now(),
                 updated_by = ${input.actorId}
           where id = ${source.journal_entry_id} and org_id = ${input.orgId}
        `);
        await tx.execute(sql`
          update recognition_schedule_lines
             set reversal_journal_entry_id = ${reversalId},
                 updated_at = now(), updated_by = ${input.actorId}
           where id = ${source.line_id} and org_id = ${input.orgId}
        `);
        reversalIds.push(reversalId);
      }

      await tx.execute(sql`
        update performance_obligations
           set status = 'cancelled',
               cancellation_reason = coalesce(cancellation_reason, ${reason}),
               cancelled_at = coalesce(cancelled_at, now()),
               cancelled_by = coalesce(cancelled_by, ${input.actorId}),
               updated_at = now(), updated_by = ${input.actorId}
         where id = any(${`{${obligationIds.join(",")}}`}::uuid[])
           and org_id = ${input.orgId}
           and status <> 'cancelled'
      `);
      await tx.execute(sql`
        update recognition_schedules
           set status = 'cancelled', updated_at = now(),
               updated_by = ${input.actorId}
         where obligation_id =
           any(${`{${obligationIds.join(",")}}`}::uuid[])
           and org_id = ${input.orgId}
           and status <> 'cancelled'
      `);
      const contractIds = [...new Set(obligations.rows.map((row) => row.contract_id))];
      await tx.execute(sql`
        update revenue_contracts contract
           set status = 'cancelled', updated_at = now(),
               updated_by = ${input.actorId}
         where contract.id = any(${`{${contractIds.join(",")}}`}::uuid[])
           and contract.org_id = ${input.orgId}
           and not exists (
             select 1
               from performance_obligations obligation
              where obligation.contract_id = contract.id
                and obligation.org_id = contract.org_id
                and obligation.status <> 'cancelled'
           )
      `);
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${input.orgId}, 'performance_obligations', ${input.documentId},
          'update',
          ${JSON.stringify({
            mode: "revenue_recognition_cancellation",
            reason,
            reversalDate,
            obligationIds,
          })}::jsonb,
          ${input.actorId}, 'revenue_recognition_cancellation'
        )
      `);
      if (doc.status === "voided") {
        return {
          status: "cancelled" as const,
          recognitionReversalEntryIds: reversalIds,
          invoiceReversalEntryId: doc.reversal_entry_id,
          runId: null,
        };
      }

      // The normal void path owns document reversal, approval routing, audit
      // snapshots, applications, and period controls. Run it while this
      // transaction is still open so a failure rolls back the recognition
      // reversals as well. An overlapping request is completed rather than
      // claimed a second time.
      const {
        completeRequestedDocumentVoid,
        requestDocumentVoid,
      } = await import("../ledger/document-void.ts");
      if (doc.void_requested_at) {
        const invoiceReversalEntryId =
          await completeRequestedDocumentVoid(input.documentId, input.orgId);
        return {
          status: "cancelled" as const,
          recognitionReversalEntryIds: reversalIds,
          invoiceReversalEntryId,
          runId: null,
        };
      }
      const requested = await requestDocumentVoid({
        documentId: input.documentId,
        orgId: input.orgId,
        actorId: input.actorId,
        reason,
        reversalDate,
        source: "api",
      });
      return {
        status:
          requested.status === "voided" ? "cancelled" : "pending_approval",
        recognitionReversalEntryIds: reversalIds,
        invoiceReversalEntryId: requested.reversalEntryId,
        runId: requested.runId,
      };
    }),
  );
    } catch (error) {
      // Preserve the previous bounded retry behavior, but retry the complete
      // unit so a failed void never leaves durable recognition side effects.
      if (attempt === 2) throw error;
    }
  }
  throw new RevenueRecognitionCancellationError(
    "invoice cancellation could not be finalized",
  );
}

/* ------------------------------------------------------------------ *
 * Review-and-confirm: the read-only preview behind the Run recognition
 * drawer, and the fingerprint Confirm carries back.
 * ------------------------------------------------------------------ */

export interface RecognitionPreviewInput {
  asOfDate: string;
  /** One obligation, as the contract drawer's per-obligation run does. */
  obligationId?: string;
  /** Every obligation on one contract. */
  contractId?: string;
  /** One accounting book; omitted means every GL-posting book. */
  bookId?: string;
  /** One accounting period. */
  periodId?: string;
  allowedSubsidiaryIds?: string[];
}

/** Exactly the fields the confirm fingerprint covers per line. */
export interface FingerprintedRecognitionLine {
  lineId: string;
  /** What would post — the planned amount after the unearned cap. */
  amount: string;
  periodId: string;
  bookId: string;
  debitAccountId: string | null;
  creditAccountId: string | null;
  subsidiaryId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
}

/**
 * Why a previewed line would NOT post. Named here rather than discovered at
 * post time: the operator decides before anything is written.
 *
 * - `period_closed`   the GL period is locked for this book/entity
 * - `not_configured`  no deferred or no recognized account resolves
 * - `credit_capped`   a credit memo already relieved the whole remainder
 * - `negative_floor`  a correction would drive cumulative earned negative
 * - `zero`            a zero plan line: closed out, never posted
 */
export type RecognitionSkipReason =
  | "period_closed"
  | "not_configured"
  | "credit_capped"
  | "negative_floor"
  | "zero";

export interface RecognitionPreviewRow extends FingerprintedRecognitionLine {
  obligationId: string;
  obligationDescription: string;
  contractNumber: string;
  periodName: string;
  periodEndsOn: string;
  recognitionOn: string | null;
  method: RecognitionMethod;
  bookName: string;
  subsidiaryName: string | null;
  departmentName: string | null;
  projectName: string | null;
  /** The plan line before the unearned cap; differs from `amount` when a
   *  credit memo already relieved part of the remainder. */
  plannedAmount: string;
  /** Transaction currency and the rate the posting converts at. */
  currency: string | null;
  baseCurrency: string | null;
  fxRate: string;
  debitAccountNumber: string | null;
  debitAccountName: string | null;
  creditAccountNumber: string | null;
  creditAccountName: string | null;
  /** Null when this line posts. Otherwise the named refusal above. */
  skipReason: RecognitionSkipReason | null;
  /** Operator-readable detail behind `skipReason` (amounts, period name). */
  skipDetail: string | null;
}

export interface RecognitionPreview {
  asOfDate: string;
  obligationId: string | null;
  contractId: string | null;
  bookId: string | null;
  periodId: string | null;
  /** Every due line in scope, postable and skipped alike — the operator sees
   *  what will NOT post as clearly as what will. */
  rows: RecognitionPreviewRow[];
  postableCount: number;
  skippedCount: number;
  totalAmount: string;
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  /**
   * Fixed-price project contracts whose percent-complete measurement is
   * refreshed before a run posts. Confirm performs that refresh, so the
   * preview names it instead of letting it happen invisibly.
   */
  projectSyncPending: boolean;
  warnings: string[];
  /**
   * Stale-input fence: sha256 over the scope plus every previewed line id,
   * amount, period, book, account, entity and dimension. Confirm recomputes
   * over current state and refuses on mismatch.
   */
  fingerprint: string;
}

/**
 * Fingerprint the exact confirmable set: the scope AND every postable line's
 * amount, period, book, accounts, entity and dimensions. Skipped lines are
 * excluded — they write nothing, and a skip that later clears simply means a
 * fresh preview shows more to post.
 */
export function recognitionPreviewFingerprint(
  orgId: string,
  input: RecognitionPreviewInput,
  rows: FingerprintedRecognitionLine[],
): string {
  const normalized = {
    orgId,
    asOfDate: input.asOfDate,
    obligationId: input.obligationId ?? null,
    contractId: input.contractId ?? null,
    bookId: input.bookId ?? null,
    periodId: input.periodId ?? null,
    rows: [...rows]
      .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0))
      .map((row) => ({
        lineId: row.lineId,
        amount: row.amount,
        periodId: row.periodId,
        bookId: row.bookId,
        debitAccountId: row.debitAccountId,
        creditAccountId: row.creditAccountId,
        subsidiaryId: row.subsidiaryId,
        departmentId: row.departmentId,
        projectId: row.projectId,
        locationId: row.locationId,
      })),
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

/** Names for the ids a preview row carries, resolved in one pass. */
async function recognitionPreviewNames(
  runner: SqlExecutor,
  orgId: string,
  ids: {
    accountIds: string[];
    bookIds: string[];
    subsidiaryIds: string[];
    departmentIds: string[];
    projectIds: string[];
  },
): Promise<{
  accounts: Map<string, { number: string | null; name: string | null }>;
  books: Map<string, string>;
  subsidiaries: Map<string, string>;
  departments: Map<string, string>;
  projects: Map<string, string>;
}> {
  const list = (values: string[]) => `{${[...new Set(values)].join(",")}}`;
  const accounts = new Map<string, { number: string | null; name: string | null }>();
  const books = new Map<string, string>();
  const subsidiaries = new Map<string, string>();
  const departments = new Map<string, string>();
  const projects = new Map<string, string>();
  if (ids.accountIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; number: string | null; name: string | null }>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and id = any(${list(ids.accountIds)}::uuid[])`)).rows) {
      accounts.set(String(row.id), { number: row.number, name: row.name });
    }
  }
  if (ids.bookIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from accounting_books
       where org_id = ${orgId} and id = any(${list(ids.bookIds)}::uuid[])`)).rows) {
      books.set(String(row.id), row.name);
    }
  }
  if (ids.subsidiaryIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from subsidiaries
       where org_id = ${orgId} and id = any(${list(ids.subsidiaryIds)}::uuid[])`)).rows) {
      subsidiaries.set(String(row.id), row.name);
    }
  }
  if (ids.departmentIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from departments
       where org_id = ${orgId} and id = any(${list(ids.departmentIds)}::uuid[])`)).rows) {
      departments.set(String(row.id), row.name);
    }
  }
  if (ids.projectIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from projects
       where org_id = ${orgId} and id = any(${list(ids.projectIds)}::uuid[])`)).rows) {
      projects.set(String(row.id), row.name);
    }
  }
  return { accounts, books, subsidiaries, departments, projects };
}

/**
 * Read-only revenue-recognition preview for the review/confirm drawer: the
 * exact balanced accounting impact of confirming this scope — one DR
 * deferred / CR recognized pair per due line — plus the fingerprint Confirm
 * must carry back.
 *
 * Pure SELECTs: no locks, no claims, no postings, and no project
 * re-measurement. Every refusal the run would reach (closed period, missing
 * accounts, credit-exhausted remainder, negative floor) is evaluated HERE and
 * shown per line, so the operator never learns about a skip from a toast
 * after the fact.
 */
export async function previewRevenueRecognition(
  orgId: string,
  input: RecognitionPreviewInput,
): Promise<RecognitionPreview> {
  recognitionDate(input.asOfDate, "recognition as-of date");
  await assertEnabled(db, orgId);
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));

  const due = await recognitionPostingRows(
    db,
    orgId,
    input.asOfDate,
    fallbackSubsidiaryId,
    input.obligationId,
    input.allowedSubsidiaryIds,
  );

  // Contract and book/period narrowing ride on top of the one due-rows
  // reader, so the preview can never see a line the run would not.
  const contractLineIds = input.contractId
    ? new Set(
        (await db.execute<{ id: string }>(sql`
          select l.id from recognition_schedule_lines l
           join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
           join performance_obligations o on o.id = s.obligation_id and o.org_id = s.org_id
           where l.org_id = ${orgId} and o.contract_id = ${input.contractId}`)).rows.map((row) =>
          String(row.id),
        ),
      )
    : null;

  const scoped = due.filter((row) => {
    if (input.bookId && row.book_id !== input.bookId) return false;
    if (input.periodId && row.period_id !== input.periodId) return false;
    if (contractLineIds && !contractLineIds.has(row.line_id)) return false;
    return true;
  });

  const names = await recognitionPreviewNames(db, orgId, {
    accountIds: scoped.flatMap((row) =>
      [
        row.obl_deferred ?? row.item_deferred ?? row.rule_deferred,
        row.obl_recognized ?? row.rule_recognized ?? row.item_income,
      ].filter((id): id is string => Boolean(id)),
    ),
    bookIds: scoped.map((row) => row.book_id),
    subsidiaryIds: scoped.map((row) => row.subsidiary_id).filter((id): id is string => Boolean(id)),
    departmentIds: scoped.map((row) => row.department_id).filter((id): id is string => Boolean(id)),
    projectIds: scoped.map((row) => row.project_id).filter((id): id is string => Boolean(id)),
  });

  const rows: RecognitionPreviewRow[] = [];
  const warnings: string[] = [];
  let totalAmount = "0";

  for (const row of scoped) {
    const deferredAccountId = row.obl_deferred ?? row.item_deferred ?? row.rule_deferred;
    const recognizedAccountId = row.obl_recognized ?? row.rule_recognized ?? row.item_income;
    const debit = deferredAccountId ? names.accounts.get(deferredAccountId) : undefined;
    const credit = recognizedAccountId ? names.accounts.get(recognizedAccountId) : undefined;

    let skipReason: RecognitionSkipReason | null = null;
    let skipDetail: string | null = null;
    let amount = row.planned;

    if (isZero(row.planned)) {
      skipReason = "zero";
      skipDetail = null;
      amount = "0";
    } else if (!deferredAccountId || !recognizedAccountId) {
      skipReason = "not_configured";
      skipDetail = !deferredAccountId
        ? "no deferred revenue account resolves for this obligation"
        : "no recognized revenue account resolves for this obligation";
      amount = "0";
    } else if (
      !(await arePeriodModulesOpen(db, {
        orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryIds: row.subsidiary_id ? [row.subsidiary_id] : [],
        modules: ["gl"],
      }))
    ) {
      skipReason = "period_closed";
      skipDetail = row.period_name;
      amount = "0";
    } else if (cmp(row.planned, "0") > 0) {
      // The same unearned ceiling the run applies (F-w5-001), read-only.
      const cap = await recognitionUnearnedRemaining(db, {
        orgId,
        obligationId: row.obligation_id,
        bookId: row.book_id,
        deferredAccountId,
      });
      if (cmp(cap.remaining, "0") <= 0) {
        skipReason = "credit_capped";
        skipDetail = cap.credited;
        amount = "0";
      } else if (cmp(row.planned, cap.remaining) > 0) {
        amount = cap.remaining;
      }
    } else {
      const net = await recognitionNetRecognized(db, {
        orgId,
        obligationId: row.obligation_id,
        bookId: row.book_id,
      });
      if (cmp(add(net, row.planned), "0") < 0) {
        skipReason = "negative_floor";
        skipDetail = net;
        amount = "0";
      }
    }

    if (skipReason === null) totalAmount = add(totalAmount, recognitionBaseAmount(amount, row.recognition_fx_rate));

    rows.push({
      lineId: row.line_id,
      amount,
      periodId: row.period_id,
      bookId: row.book_id,
      debitAccountId: deferredAccountId,
      creditAccountId: recognizedAccountId,
      subsidiaryId: row.subsidiary_id,
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      obligationId: row.obligation_id,
      obligationDescription: row.obligation_desc,
      contractNumber: row.contract_number,
      periodName: row.period_name,
      periodEndsOn: row.period_ends_on,
      recognitionOn: row.recognition_on,
      method: row.method,
      bookName: names.books.get(row.book_id) ?? row.book_id,
      subsidiaryName: row.subsidiary_id ? names.subsidiaries.get(row.subsidiary_id) ?? null : null,
      departmentName: row.department_id ? names.departments.get(row.department_id) ?? null : null,
      projectName: row.project_id ? names.projects.get(row.project_id) ?? null : null,
      plannedAmount: row.planned,
      currency: row.recognition_currency ?? row.base_currency,
      baseCurrency: row.base_currency,
      fxRate: row.recognition_fx_rate,
      debitAccountNumber: debit?.number ?? null,
      debitAccountName: debit?.name ?? null,
      creditAccountNumber: credit?.number ?? null,
      creditAccountName: credit?.name ?? null,
      skipReason,
      skipDetail,
    });
  }

  const postable = rows.filter((row) => row.skipReason === null);
  if (rows.length > postable.length) {
    warnings.push(`${rows.length - postable.length} due line(s) will not post`);
  }

  // Percent-complete obligations are re-measured by Confirm before it posts.
  // Say so here: the refresh can add catch-up lines this preview cannot show.
  const projectSyncPending = scoped.some((row) => row.method === "percent_complete");
  if (projectSyncPending) {
    warnings.push(
      "percent-complete progress is re-measured on confirm; newly projected catch-up lines wait for the next run",
    );
  }

  return {
    asOfDate: input.asOfDate,
    obligationId: input.obligationId ?? null,
    contractId: input.contractId ?? null,
    bookId: input.bookId ?? null,
    periodId: input.periodId ?? null,
    rows,
    postableCount: postable.length,
    skippedCount: rows.length - postable.length,
    totalAmount,
    // One balanced pair per line: the debit total is the credit total by
    // construction, and the badge states it rather than assuming it.
    totalDebits: totalAmount,
    totalCredits: totalAmount,
    balanced: true,
    projectSyncPending,
    warnings,
    fingerprint: recognitionPreviewFingerprint(orgId, input, postable),
  };
}
