import { sql } from "drizzle-orm";
import { db, type SqlExecutor, withOrg } from "./db.ts";
import { add, cmp, fromUnits, isZero, mul, mulPercent, neg, roundDiv, sum, toUnits } from "./money.ts";
import {
  periodInterest,
  periodRateFromAnnualPercent,
  type AccretionPeriod,
} from "./present-value.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "./subsidiaries.ts";

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

/** First day of the month for a YYYY-MM-DD date, as YYYY-MM-01. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/** Days in the calendar month containing a YYYY-MM-DD date. */
function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** Last day of the month for a YYYY-MM-DD date, as YYYY-MM-DD. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(daysInMonth(date)).padStart(2, "0")}`;
}

/** Parse YYYY-MM-DD to a UTC epoch-day integer. */
function epochDay(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d) / 86_400_000);
}

/** Inclusive day count between two YYYY-MM-DD dates (end − start + 1). */
function inclusiveDays(startOn: string, endOn: string): number {
  return epochDay(endOn) - epochDay(startOn) + 1;
}

/** Shift a YYYY-MM-DD date by n days, returning YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  const t = (epochDay(date) + n) * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
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
 * Obligations with no SSP fall back to their booked amount as the weight.
 */
export function allocateByRelativeSSP(
  total: string,
  obligations: { ssp?: string | null; booked?: string | null }[],
): string[] {
  const weights = obligations.map((o) => o.ssp != null && o.ssp !== "" ? o.ssp : (o.booked ?? "0"));
  return apportion(toUnits(total), weights).map(fromUnits);
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
  const qty = quantity != null && cmp(quantity, "0") > 0 ? quantity : "1";
  if (low != null && cmp(allocated, mul(low, qty)) < 0) return "below_range";
  if (high != null && cmp(allocated, mul(high, qty)) > 0) return "above_range";
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

/** Registry default is on — absence must not disable recognition. */
export async function revenueRecognitionFeatureEnabled(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<boolean> {
  const result = await runner.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'revenueRecognition')::boolean, true) as enabled
      from orgs where id = ${orgId}
  `);
  return result.rows[0]?.enabled === true;
}

async function assertEnabled(runner: Pick<typeof db, "execute">, orgId: string): Promise<void> {
  if (!(await revenueRecognitionFeatureEnabled(runner, orgId))) {
    throw new RevenueRecognitionError("Revenue recognition feature is disabled");
  }
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
export function separateFinancingComponent(
  input: FinancingComponentInput,
): FinancingComponentResult {
  if (input.years <= 0) throw new TransactionPriceError("financing deferral must be at least one year");
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
     returning id`));
  if (!updated.rows[0]) throw new TransactionPriceError("revenue contract not found");

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
  const clamped = cmp(pct, "0") < 0 ? "0" : cmp(pct, "100") > 0 ? "100" : pct;
  return toUnits(mulPercent(fromUnits(totalUnits), clamped, 4));
}

/** Resolve the term end from an explicit endOn, else start + termPeriods. */
function resolveEnd(startOn: string, input: RecognitionInput): string {
  if (input.endOn) return input.endOn;
  const term = Math.max(1, Math.trunc(input.termPeriods ?? 1));
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
  const periodOffset = Math.max(0, Math.trunc(input.periodOffset ?? 0));
  const rawStart = input.startOffsetDays ? addDays(input.startOn, Math.trunc(input.startOffsetDays)) : input.startOn;
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
      throw new Error(`recognition end (${end}) precedes the recognition start (${rawStart})`);
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
        return (input.events ?? []).map((e) => ({ month: monthStart(e.periodMonth), units: toUnits(e.amount) }));

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
        return [];
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

/** Primary accounting book id (schedules are book-aware). */
async function primaryBookId(runner: SqlExecutor, orgId: string): Promise<string> {
  const res = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`));
  if (!res.rows[0]) throw new Error("no primary accounting book");
  return res.rows[0].id;
}

/** Resolve the (non-adjustment) accounting period covering a date, or null. */
async function periodForDate(runner: SqlExecutor, orgId: string, date: string): Promise<string | null> {
  const res = (await runner.execute<{ id: string }>(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false
       and starts_on <= ${date} and ends_on >= ${date}
     limit 1`));
  return res.rows[0]?.id ?? null;
}

export interface BuildRecognitionResult {
  scheduleId: string;
  lineCount: number;
  /** months that had no accounting period and were skipped. */
  skippedMonths: string[];
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
async function buildRecognitionScheduleOn(
  runner: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  bookId: string,
  asOfDate?: string,
): Promise<BuildRecognitionResult> {
  const oblRes = (await runner.execute<{
      id: string;
      allocated_price: string;
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
    select o.id, o.allocated_price, o.recognition_starts_on, o.recognition_ends_on,
           o.percent_complete, c.starts_on as contract_starts, c.ends_on as contract_ends,
           r.method, r.recognition_periods, r.period_offset, r.start_offset_days,
           r.initial_amount_percent, r.start_date_source, r.end_date_source
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}`));
  const o = oblRes.rows[0];
  if (!o) throw new Error("obligation not found");

  const startOn = o.recognition_starts_on ?? o.contract_starts;
  if (!startOn) throw new Error("obligation has no recognition start date");
  const endOn = o.recognition_ends_on ?? (o.end_date_source === "contract" ? o.contract_ends : null);
  const isPercentComplete = o.method === "percent_complete";

  const existing = (await runner.execute<{ id: string }>(sql`
    select id from recognition_schedules
     where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`));
  let scheduleId: string;
  if (existing.rows[0]) {
    scheduleId = existing.rows[0].id;
    await runner.execute(sql`
      update recognition_schedules
         set total_amount = ${o.allocated_price}, updated_at = now(), updated_by = ${actorId}
       where id = ${scheduleId} and org_id = ${orgId}`);
    } else {
      // Concurrent replays may race on the (obligation, book) identity; lose
      // deterministically to the winner and adopt its row instead of failing.
      const ins = (await runner.execute<{ id: string }>(sql`
        insert into recognition_schedules (org_id, obligation_id, book_id, total_amount, created_by, updated_by)
        values (${orgId}, ${obligationId}, ${bookId}, ${o.allocated_price}, ${actorId}, ${actorId})
        on conflict do nothing
        returning id`));
      scheduleId =
        ins.rows[0]?.id ??
        (await runner.execute<{ id: string }>(sql`
          select id from recognition_schedules
           where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`)).rows[0]!.id;
    }

  const posted = (await runner.execute<{ period_id: string; planned_amount: string; sequence: number }>(sql`
    select period_id, planned_amount, sequence from recognition_schedule_lines
     where org_id = ${orgId} and schedule_id = ${scheduleId} and journal_entry_id is not null`));
  const postedPeriods = new Set(posted.rows.map((r) => r.period_id));
  const postedToDate = sum(posted.rows.map((r) => r.planned_amount));
  const nextSequence = posted.rows.reduce((a, r) => Math.max(a, r.sequence + 1), 0);

  // Milestone and usage methods recognize from recorded events rather than
  // a term. Load the obligation's persisted events so computeRecognitionSchedule
  // produces one line per event instead of a zero-line schedule.
  const isMilestoneOrUsage = o.method === "milestone" || o.method === "usage";
  let events: { periodMonth: string; amount: string }[] | undefined;
  if (isMilestoneOrUsage) {
    const eventRes = (await runner.execute<{ period_month: string; amount: string }>(sql`
      select period_month, amount from recognition_events
       where org_id = ${orgId} and obligation_id = ${obligationId}
       order by period_month`));
    events = eventRes.rows.map((e) => ({ periodMonth: e.period_month, amount: e.amount }));
  }

  // Percent-complete: the catch-up delta lands in the as-of month (clamped to
  // the term start), credited for everything this schedule already posted.
  const plan = computeRecognitionSchedule({
    total: o.allocated_price,
    method: o.method,
    startOn: isPercentComplete && asOfDate && asOfDate > startOn ? asOfDate : startOn,
    endOn,
    termPeriods: o.recognition_periods,
    startOffsetDays: o.start_offset_days,
    initialAmountPercent: o.initial_amount_percent,
    periodOffset: o.period_offset,
    percentComplete: o.percent_complete,
    alreadyRecognized: isPercentComplete ? postedToDate : null,
    events,
  });

  await runner.execute(sql`
    delete from recognition_schedule_lines where org_id = ${orgId} and schedule_id = ${scheduleId} and journal_entry_id is null`);

  const skippedMonths: string[] = [];
  let lineCount = 0;
  for (const p of plan) {
    const periodId = await periodForDate(runner, orgId, p.periodMonth);
    if (!periodId) {
      throw new RevenueRecognitionError(
        `no accounting period covers ${p.periodMonth} — provision all periods spanning the recognition term before building a schedule`,
      );
    }
    // A period that already recognized is closed to re-planning — EXCEPT for
    // percent_complete, where later catch-ups legitimately post additional
    // lines into the current period (distinct sequence numbers).
    if (!isPercentComplete && postedPeriods.has(periodId)) continue;
    if (isPercentComplete && isZero(p.planned)) continue;
    // Keep the rule's sequence for term/event schedules.  Their unposted
    // lines represent fixed periods in the plan, so offsetting them by the
    // count of posted lines would shift every line after the first posted
    // period on a replay.  Percent-complete is different: each rebuild is a
    // new catch-up entry, so it deliberately appends after posted sequences.
    const sequence = isPercentComplete ? nextSequence + p.sequence : p.sequence;
    await runner.execute(sql`
      insert into recognition_schedule_lines
        (org_id, schedule_id, period_id, sequence, planned_amount, created_by, updated_by)
      values (${orgId}, ${scheduleId}, ${periodId}, ${sequence}, ${p.planned}, ${actorId}, ${actorId})`);
    lineCount++;
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
  return buildAllRecognitionSchedulesOn(db, obligationId, orgId, actorId, asOfDate);
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
  sourceReference?: string | null;
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
 * will load these events and produce one schedule line per event.
 *
 * Corrections and amendments are additive — posting history is never rewritten.
 * A correction event with a negative amount reverses the prior recognition in
 * the affected period through the normal schedule-rebuild / posting flow.
 */
export async function recordRecognitionEvent(
  input: RecordRecognitionEventInput,
): Promise<RecordRecognitionEventResult> {
  await assertEnabled(db, input.orgId);
  // Validate the obligation exists and uses a milestone or usage method.
  const oblRes = (await db.execute<{ id: string; method: string }>(sql`
    select o.id, r.method
      from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.id = ${input.obligationId} and o.org_id = ${input.orgId}`));
  if (!oblRes.rows[0]) {
    throw new RevenueRecognitionError("obligation not found");
  }
  if (oblRes.rows[0].method !== "milestone" && oblRes.rows[0].method !== "usage") {
    throw new RevenueRecognitionError(
      `recognition method '${oblRes.rows[0].method}' does not accept events; only milestone and usage methods are supported`,
    );
  }

  const res = (await db.execute<{ id: string }>(sql`
    insert into recognition_events
      (org_id, obligation_id, period_month, amount, description, source_reference,
       unit_rate, quantity, created_by, updated_by)
    values (${input.orgId}, ${input.obligationId}, ${input.periodMonth},
            ${input.amount}, ${input.description ?? null}, ${input.sourceReference ?? null},
            ${input.unitRate ?? null}, ${input.quantity ?? null},
            ${input.actorId}, ${input.actorId})
    returning id`));
  const eventId = res.rows[0]!.id;

  // Rebuild the obligation's schedule on every GL-posting book so the new
  // event immediately appears as a planned recognition line.
  await buildAllRecognitionSchedulesOn(db, input.obligationId, input.orgId, input.actorId);

  return { eventId };
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
  const existing = (await db.execute<{ id: string; document_line_id: string }>(sql`
    select id, document_line_id from performance_obligations
     where org_id = ${orgId} and document_line_id = any(${`{${lineRes.rows.map((l) => l.line_id).join(",")}}`}::uuid[])`));
  const already = new Set(existing.rows.map((r) => r.document_line_id));
  const existingObligationIds = existing.rows.map((r) => r.id);
  const lines = lineRes.rows.filter((l) => !already.has(l.line_id));

  // Relative-SSP allocation over the bundle of new rev-rec lines. Lines flagged
  // 'exclude' from allocation keep their booked amount and don't dilute others.
  const included = lines.filter((l) => l.revenue_allocation !== "exclude");
  const bundleTotal = sum(included.map((l) => l.amount));
  const alloc = allocateByRelativeSSP(
    bundleTotal,
    included.map((l) => ({ ssp: l.item_ssp ?? l.fair_value, booked: l.amount })),
  );
  const allocByLine = new Map<string, string>();
  included.forEach((l, i) => allocByLine.set(l.line_id, alloc[i]!));
  for (const l of lines) if (l.revenue_allocation === "exclude") allocByLine.set(l.line_id, l.amount);

  const obligationIds: string[] = [];
  const contractId = await db.transaction(async (tx) => {
    let cId: string | null = null;
    if (lines.length > 0) {
      // One contract per invoice. The unique storage key is the concurrency
      // authority; contract_number remains business display data, not a mutex.
      const contractKey = revenueContractPostingEffectKey(documentId);
      const insertedContract = await tx.execute<{ id: string }>(sql`
        insert into revenue_contracts
          (org_id, customer_id, contract_number, idempotency_key, status, starts_on,
           currency, total_transaction_price, created_by, updated_by)
        values (${orgId}, ${doc.party_id}, ${doc.document_number}, ${contractKey}, 'active',
                ${doc.document_date}, ${doc.currency}, ${bundleTotal}, ${actorId}, ${actorId})
        on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
        returning id
      `);
      const existingContract = insertedContract.rows[0]
        ? null
        : await tx.execute<{ id: string }>(sql`
            select id from revenue_contracts
             where org_id=${orgId} and idempotency_key=${contractKey}
          `);
      cId = insertedContract.rows[0]?.id ?? existingContract?.rows[0]?.id ?? null;
      if (!cId) throw new Error("revenue contract idempotency winner was not visible");

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
 * Post every due, unposted recognition line whose period ends on or before
 * `asOfDate`. Each line becomes one balanced journal entry (DR deferred / CR
 * recognized) posted through the kernel, origin = 'revenue_recognition'. A
 * closed GL period is skipped (not an error). Idempotent: a line with a
 * journal_entry_id is never reconsidered.
 */
export async function runRevenueRecognition(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  obligationId?: string,
  allowedSubsidiaryIds?: string[],
): Promise<RunRecognitionResult> {
  await assertEnabled(db, orgId);
  const subsidiaryContext = await loadSubsidiaryContext(db, orgId);

  const due = (await db.execute<any>(sql`
    select l.id             as line_id,
           l.planned_amount as planned,
           l.period_id      as period_id,
           l.sequence       as sequence,
           s.book_id        as book_id,
           p.name           as period_name,
           p.ends_on        as period_ends_on,
           r.method         as method,
           period_module_is_closed(
             ${orgId}, p.id, s.book_id,
             coalesce(dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, sub0.id),
             'gl'
           ) as period_closed,
           o.id             as obligation_id,
           o.description    as obligation_desc,
           o.deferred_account_id    as obl_deferred,
           o.recognized_account_id  as obl_recognized,
           it.deferred_account_id   as item_deferred,
           it.income_account_id     as item_income,
           r.deferred_account_id    as rule_deferred,
           r.recognized_account_id  as rule_recognized,
           c.contract_number as contract_number,
           coalesce(dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, sub0.id) as subsidiary_id,
           coalesce(sub.base_currency, psub.base_currency, sub0.base_currency) as base_currency,
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
      left join subsidiaries sub on sub.id = coalesce(dl.subsidiary_id, doc.subsidiary_id) and sub.org_id = o.org_id
      left join subsidiaries psub on psub.id = prj.subsidiary_id and psub.org_id = prj.org_id
      left join lateral (
        select id, base_currency from subsidiaries where org_id = ${orgId} order by created_at limit 1
      ) sub0 on true
     where l.org_id = ${orgId}
       and l.journal_entry_id is null
       and o.status <> 'cancelled'
       -- Scheduled methods recognize a period once it has ENDED; percent_complete
       -- is a measurement AS OF the date, so its catch-up in the current period
       -- is due as soon as the period has started.
       and (p.ends_on <= ${asOfDate}
            or (r.method = 'percent_complete' and p.starts_on <= ${asOfDate}))
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       ${allowedSubsidiaryIds ? sql`and coalesce(dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, sub0.id) = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
     order by c.contract_number, o.description, l.sequence`));

  const result: RunRecognitionResult = { posted: 0, skipped: 0, totalAmount: "0", entries: [], problems: [] };

  for (const row of due.rows) {
    const planned: string = row.planned;
    if (isZero(planned)) {
      await db.execute(sql`
        update recognition_schedule_lines set recognized_amount = '0', updated_at = now() where id = ${row.line_id} and org_id = ${orgId}`);
      result.skipped++;
      continue;
    }
    if (row.period_closed) {
      result.skipped++;
      result.problems.push(`${row.contract_number} ${row.period_name}: GL period closed`);
      continue;
    }

    const deferredAccountId = row.obl_deferred ?? row.item_deferred ?? row.rule_deferred;
    const recognizedAccountId = row.obl_recognized ?? row.rule_recognized ?? row.item_income;
    if (!deferredAccountId || !recognizedAccountId) {
      result.skipped++;
      result.problems.push(`${row.contract_number} ${row.obligation_desc}: deferred/recognized account not configured`);
      continue;
    }

    // DR deferred (+planned), CR recognized (−planned) — balanced by construction.
    const lines = [
      { accountId: deferredAccountId, amount: planned },
      { accountId: recognizedAccountId, amount: neg(planned) },
    ];
    try {
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx: subsidiaryContext,
        docSubsidiaryId: row.subsidiary_id,
        lines: lines.map((line) => ({
          ...line,
          subsidiaryId: row.subsidiary_id,
          departmentId: row.department_id,
          projectId: row.project_id,
          locationId: row.location_id,
          classId: row.class_id,
        })),
      });
    } catch (error) {
      result.problems.push(`${row.contract_number} ${row.period_name}: ${(error as Error).message}`);
      continue;
    }
    const bal = sum(lines.map((l) => l.amount));
    if (!isZero(bal)) {
      result.problems.push(`${row.contract_number} ${row.period_name}: unbalanced (${bal})`);
      continue;
    }

    // Scheduled lines post at period end; a percent_complete catch-up in the
    // still-open current period posts at the measurement (as-of) date instead
    // of future-dating to period end.
    const postingDate: string =
      row.method === "percent_complete" && asOfDate < row.period_ends_on ? asOfDate : row.period_ends_on;
    try {
      const posted = await db.transaction(async (tx) => {
        // Claim the schedule line at the aggregate root. Concurrent runners
        // serialize here; after the winner commits, the loser no longer
        // satisfies journal_entry_id is null and cannot create a second entry.
        // Recheck the GL close under the same lock so a period cannot close
        // between the preliminary scan and the actual ledger write.
        const claim = (await tx.execute<{ id: string; period_closed: boolean }>(sql`
          select l.id,
                 period_module_is_closed(
                   ${orgId}, l.period_id, s.book_id, ${row.subsidiary_id}, 'gl'
                 ) as period_closed
            from recognition_schedule_lines l
            join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
           where l.id = ${row.line_id}
             and l.org_id = ${orgId}
             and l.journal_entry_id is null
           for update of l`));
        if (!claim.rows[0]) return { status: "already_posted" as const };
        if (claim.rows[0].period_closed) return { status: "period_closed" as const };

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
            values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${row.subsidiary_id}, ${l.amount}, ${row.base_currency}, ${l.amount}, 1,
                    ${row.department_id}, ${row.project_id}, ${row.location_id}, ${row.class_id},
                    ${row.equipment_unit_id}, ${JSON.stringify(row.extra_dims ?? {})}::jsonb,
                    ${`Revenue recognition ${row.period_name}`})`);
        }

        await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${eid} and org_id = ${orgId}`);

        await tx.execute(sql`
          update recognition_schedule_lines
             set recognized_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id} and org_id = ${orgId}`);

        return { status: "posted" as const, entryId: eid };
      });

      if (posted.status === "already_posted") {
        result.skipped++;
        continue;
      }
      if (posted.status === "period_closed") {
        result.skipped++;
        result.problems.push(`${row.contract_number} ${row.period_name}: GL period closed`);
        continue;
      }
      result.posted++;
      result.totalAmount = add(result.totalAmount, planned);
      result.entries.push({
        contract: row.contract_number,
        obligation: row.obligation_desc,
        period: row.period_name,
        amount: planned,
        entryId: posted.entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${row.contract_number} ${row.period_name}: ${msg.slice(0, 120)}`);
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
       and r.method in ('milestone', 'usage')
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and (
         not exists (select 1 from recognition_schedules s where s.obligation_id = o.id and s.org_id = o.org_id)
         or (
           exists (select 1 from recognition_schedules s where s.obligation_id = o.id and s.org_id = o.org_id)
           and not exists (
             select 1 from recognition_schedule_lines l
               join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
              where s.obligation_id = o.id and s.org_id = o.org_id)
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
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and (r.method <> 'percent_complete' or coalesce(o.percent_complete, '0')::numeric >= 100)
       and exists (
         select 1 from recognition_schedule_lines l
           join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
          where s.obligation_id = o.id and s.org_id = o.org_id)
       and not exists (
         select 1 from recognition_schedules s
           join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
          where s.obligation_id = o.id and s.org_id = o.org_id and l.journal_entry_id is null and l.planned_amount <> '0')`);

  // Advance schedule status for reporting.
  await db.execute(sql`
    update recognition_schedules s set status = case
        when not exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is null and l.planned_amount <> '0') then 'complete'
        when exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is not null) then 'in_progress'
        else 'planned' end,
      updated_at = now()
    where s.org_id = ${orgId}
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
}): Promise<CancelRevenueRecognitionResult> {
  if (!input.actorId) {
    throw new RevenueRecognitionCancellationError(
      "an attributable actor is required",
    );
  }
  const reason = cancellationReason(input.reason);
  const reversalDate = cancellationDate(input.reversalDate);

  const recognitionReversalEntryIds = await withOrg(input.orgId, () =>
    db.transaction(async (tx) => {
      const document = (await tx.execute<{ id: string; status: string }>(sql`
        select id, status
          from documents
         where id = ${input.documentId}
           and org_id = ${input.orgId}
           and kind = 'customer_invoice'
         for update
      `));
      const doc = document.rows[0];
      if (!doc) {
        throw new RevenueRecognitionCancellationError(
          "customer invoice not found",
        );
      }
      if (!["posted", "voided"].includes(doc.status)) {
        throw new RevenueRecognitionCancellationError(
          `customer invoice is ${doc.status}; only a posted invoice can be cancelled`,
        );
      }

      const obligations = (await tx.execute<{ id: string; contract_id: string; status: string }>(sql`
        select obligation.id, obligation.contract_id, obligation.status
          from performance_obligations obligation
          join document_lines line
            on line.id = obligation.document_line_id
           and line.org_id = obligation.org_id
         where obligation.org_id = ${input.orgId}
           and line.document_id = ${input.documentId}
         order by obligation.created_at, obligation.id
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
        const period = (await tx.execute<{ id: string; is_closed: boolean }>(sql`
          select period.id,
                 period_module_is_closed(
                   ${input.orgId}, period.id, ${source.book_id},
                   ${source.subsidiary_id}, 'gl'
                 ) as is_closed
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
        if (period.rows[0].is_closed) {
          throw new RevenueRecognitionCancellationError(
            `the GL period covering ${reversalDate} is closed`,
          );
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
      return reversalIds;
    }),
  );

  // The normal void path owns document reversal, approval routing, audit
  // snapshots, applications, and period controls. Handle an overlapping retry
  // by observing or completing the stored request instead of creating another.
  const {
    completeRequestedDocumentVoid,
    requestDocumentVoid,
  } = await import("./document-void.ts");
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = (await db.execute<{
        status: string;
        reversal_entry_id: string | null;
        void_requested_at: Date | null;
      }>(sql`
      select status, reversal_entry_id, void_requested_at
        from documents
       where id = ${input.documentId} and org_id = ${input.orgId}
    `));
    const doc = current.rows[0];
    if (!doc) {
      throw new RevenueRecognitionCancellationError(
        "customer invoice disappeared during cancellation",
      );
    }
    if (doc.status === "voided") {
      return {
        status: "cancelled",
        recognitionReversalEntryIds,
        invoiceReversalEntryId: doc.reversal_entry_id,
        runId: null,
      };
    }
    try {
      if (doc.void_requested_at) {
        const invoiceReversalEntryId =
          await completeRequestedDocumentVoid(input.documentId, input.orgId);
        return {
          status: "cancelled",
          recognitionReversalEntryIds,
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
        recognitionReversalEntryIds,
        invoiceReversalEntryId: requested.reversalEntryId,
        runId: requested.runId,
      };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new RevenueRecognitionCancellationError(
    "invoice cancellation could not be finalized",
  );
}
