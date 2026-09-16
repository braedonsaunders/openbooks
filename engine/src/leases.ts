import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertPeriodModulesOpen, CloseError } from "./close.ts";
import { db, type SqlExecutor } from "./db.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions, uuidArray } from "./subsidiaries.ts";
import { add, cmp, fromUnits, isZero, neg, normalizeDecimal, normalizeMoney, sum, toUnits } from "./money.ts";
import { isIsoCalendarDate } from "./business-date.ts";
import { canonicalDecimal } from "./exact-decimal.ts";
import { apportion } from "./revenue-recognition.ts";
import {
  accreteToZero,
  periodInterest,
  periodRateFromAnnualPercent,
  presentValueOfLevelStream,
  type AccretionPeriod,
  type PeriodRate,
} from "./present-value.ts";
import { orgReportingFramework, type ReportingFramework } from "./reporting-framework.ts";

/**
 * Lessee lease accounting — ASC 842 / IFRS 16 — plus the lessor classification
 * and straight-line levelling arithmetic.
 *
 * Measurement (ASC 842-20-30-1 / IFRS 16.26): at commencement the lease
 * liability is the present value of the unpaid lease payments at the rate
 * implicit in the lease or the incremental borrowing rate, and the
 * right-of-use asset is measured at cost (here: equal to the liability —
 * initial direct costs, prepayments, and incentives are out of scope of v1 and
 * belong on the measurement inputs when added).
 *
 * Models:
 *  - `finance` — interest on the liability presented separately from
 *    straight-line amortization of the right-of-use asset (every IFRS 16
 *    lease per IFRS 16.22/49; US GAAP finance leases per 842-20-25-5).
 *  - `operating` — US GAAP only (842-20-25-6): a single straight-line lease
 *    cost; the liability still unwinds on the interest method and the
 *    right-of-use asset absorbs the difference (cost − interest), which keeps
 *    asset and liability aligned through the term.
 *
 * Exemptions (ASC 842-20-25-2 / IFRS 16.5): a lease electing the short-term or
 *low-value exemption recognises no asset or liability; each payment is
 * expensed straight to the single-cost account.
 */

export class LeaseError extends Error {
  readonly name = "LeaseError";
}

function exactMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new LeaseError(`${label} must be an exact decimal`);
  try {
    return normalizeMoney(exact);
  } catch {
    throw new LeaseError(`${label} must be an exact decimal`);
  }
}

/** Persist-time annual discount rate: exact decimal at numeric(19,10). Fail closed. */
function persistLeaseAnnualDiscountRate(value: unknown): string {
  const exact = canonicalDecimal(value, 10);
  if (exact === null) throw new LeaseError("annual discount rate must be an exact decimal");
  try {
    return normalizeDecimal(exact, 10);
  } catch {
    throw new LeaseError("annual discount rate must be an exact decimal");
  }
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

export interface LeaseClassificationInputs {
  /** Ownership transfers to the lessee by the end of the term. */
  transfersOwnership?: boolean;
  /** A purchase option the lessee is reasonably certain to exercise. */
  purchaseOptionReasonablyCertain?: boolean;
  /** Lease term vs the asset's remaining economic life. */
  leaseTermMonths?: number;
  economicLifeMonths?: number;
  /** "Major part" threshold, percent (default 75 — the historical bright line). */
  termThresholdPercent?: string;
  /** PV of payments vs the asset's fair value. */
  pvOfPayments?: string;
  fairValue?: string;
  /** "Substantially all" threshold, percent (default 90). */
  pvThresholdPercent?: string;
  /** So specialised that no alternative use exists at end of term. */
  specializedAsset?: boolean;
}

export interface LeaseClassification {
  model: "finance" | "operating";
  /** Which criteria fired (empty for an operating result). */
  criteria: string[];
  framework: ReportingFramework;
}

/**
 * Classify a lessee lease. IFRS 16.22 applies the single (finance-style) model
 * to every lease; ASC 842-10-25-2 classifies as finance when ANY criterion is
 * met, else operating. Thresholds are inputs, not hardcodes — 75%/90% are the
 * customary bright lines but an entity's stated policy governs.
 */
/** Classification month counts arrive from the caller alongside the agreement;
 * a pasted or computed non-integer would otherwise die inside BigInt with a
 * raw SyntaxError instead of the domain refusal. */
function assertClassificationMonths(value: unknown, label: string): void {
  if (value == null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LeaseError(`${label} must be a non-negative whole number of months`);
  }
}

/** Classification money/threshold strings feed exact BigInt arithmetic; junk
 * would otherwise die inside the money module with a raw Error. Scale 4
 * matches the ledger precision every downstream conversion can represent. */
function assertClassificationDecimal(value: unknown, label: string): void {
  if (value == null) return;
  if (canonicalDecimal(value, 4) === null) {
    throw new LeaseError(`${label} must be an exact decimal`);
  }
}

function assertClassificationInputs(inputs: LeaseClassificationInputs): void {
  assertClassificationMonths(inputs.leaseTermMonths, "lease term months");
  assertClassificationMonths(inputs.economicLifeMonths, "economic life months");
  assertClassificationDecimal(inputs.termThresholdPercent, "term threshold percent");
  assertClassificationDecimal(inputs.pvOfPayments, "present value of payments");
  assertClassificationDecimal(inputs.fairValue, "fair value");
  assertClassificationDecimal(inputs.pvThresholdPercent, "present-value threshold percent");
}

export function classifyLease(
  inputs: LeaseClassificationInputs,
  framework: ReportingFramework,
): LeaseClassification {
  assertClassificationInputs(inputs);
  if (framework === "ifrs") {
    return { model: "finance", criteria: ["ifrs-single-model"], framework };
  }
  const criteria: string[] = [];
  if (inputs.transfersOwnership) criteria.push("ownership-transfers");
  if (inputs.purchaseOptionReasonablyCertain) criteria.push("purchase-option");
  if (
    inputs.leaseTermMonths != null &&
    inputs.economicLifeMonths != null &&
    inputs.economicLifeMonths > 0
  ) {
    const threshold = inputs.termThresholdPercent ?? "75";
    // term/life ≥ threshold%  ⇔  term × 100 ≥ life × threshold (exact integers)
    const lhs = BigInt(inputs.leaseTermMonths) * 100n * toUnits("1");
    const rhs = BigInt(inputs.economicLifeMonths) * toUnits(threshold);
    if (lhs >= rhs) criteria.push("term-major-part-of-life");
  }
  if (inputs.pvOfPayments != null && inputs.fairValue != null && cmp(inputs.fairValue, "0") > 0) {
    const threshold = inputs.pvThresholdPercent ?? "90";
    // pv/fv ≥ threshold%  ⇔  pv × 100 × 10^4 ≥ fv × threshold×10^4 (cross-multiplied)
    const lhs = toUnits(inputs.pvOfPayments) * 100n * 10_000n;
    const rhs = toUnits(inputs.fairValue) * toUnits(threshold);
    if (lhs >= rhs) criteria.push("pv-substantially-all-of-fair-value");
  }
  if (inputs.specializedAsset) criteria.push("specialized-asset");
  return {
    model: criteria.length > 0 ? "finance" : "operating",
    criteria,
    framework,
  };
}

/** Short-term exemption eligibility (ASC 842-20-25-2 / IFRS 16.5(a)): a term
 *  of twelve months or less with no purchase option reasonably certain. */
export function shortTermExemptionEligible(args: {
  leaseTermMonths: number;
  purchaseOptionReasonablyCertain?: boolean;
}): boolean {
  return args.leaseTermMonths <= 12 && !args.purchaseOptionReasonablyCertain;
}

// ---------------------------------------------------------------------------
// Schedule (pure)
// ---------------------------------------------------------------------------

export interface LesseeSchedulePeriod extends AccretionPeriod {
  /** Finance model: straight-line ROU amortization for the period. */
  amortization?: string;
  /** Operating model: the single straight-line lease cost. */
  singleCost?: string;
  /** Operating model: ROU reduction keeping asset aligned (cost − interest). */
  rouAdjustment?: string;
}

export interface LesseeMeasurement {
  liability: string;
  rouAsset: string;
  schedule: LesseeSchedulePeriod[];
}

/**
 * Measure a lease at commencement and build its full schedule.
 *
 * The liability accretes by the interest method and retires to exactly zero.
 * Finance model: ROU cost spreads straight-line via `apportion` (sums exactly,
 * residual placed deterministically). Operating model: the single cost is the
 * total payments spread straight-line; the ROU adjustment is cost − interest,
 * which by construction sums exactly to the initial ROU asset.
 */
export function measureLesseeLease(args: {
  payment: string;
  periods: number;
  annualRatePercent: string;
  periodsPerYear: number;
  timing: "arrears" | "advance";
  model: "finance" | "operating";
  /**
   * Continue-from-opening onboarding (migration 0156): a mid-life lease
   * carries its opening liability and right-of-use carrying amounts in from
   * the legacy system instead of measuring them. The accretion starts from
   * the stated liability (the terminal period still absorbs any remainder so
   * the schedule retires to exactly zero) and the ROU spreads from the
   * stated carrying amount. Absent, the opening present value is measured as
   * before and both figures equal it.
   */
  openingLiability?: string;
  openingRouAsset?: string;
}): LesseeMeasurement {
  if (args.timing === "advance") {
    throw new LeaseError("advance-timing schedules are not implemented yet — measure with arrears timing");
  }
  if (!Number.isSafeInteger(args.periodsPerYear) || args.periodsPerYear <= 0) {
    throw new LeaseError("periods per year must be a positive whole number");
  }
  if (!Number.isSafeInteger(args.periods) || args.periods < 1) {
    throw new LeaseError("lease term must be a positive whole number of periods");
  }
  // 100-year supported horizon in the caller's own frequency (division first
  // so a huge period count cannot overflow into unsafe-integer range).
  if (args.periods > (100 * args.periodsPerYear)) {
    throw new LeaseError(
      "lease term exceeds the supported 100-year horizon for its payment frequency",
    );
  }
  const rate: PeriodRate = periodRateFromAnnualPercent(args.annualRatePercent, args.periodsPerYear);
  const liability = args.openingLiability !== undefined
    ? exactMoney(args.openingLiability, "Opening liability")
    : presentValueOfLevelStream({
        payment: args.payment,
        periods: args.periods,
        rate,
        timing: args.timing,
      });
  if (cmp(liability, "0") < 0) throw new LeaseError("Opening liability must be non-negative");
  const rouAsset = args.openingRouAsset !== undefined
    ? exactMoney(args.openingRouAsset, "Opening right-of-use carrying amount")
    : liability;
  if (cmp(rouAsset, "0") < 0) throw new LeaseError("Opening right-of-use carrying amount must be non-negative");
  const accretion = accreteToZero({
    opening: liability,
    payment: args.payment,
    periods: args.periods,
    rate,
  });

  let schedule: LesseeSchedulePeriod[];
  if (args.model === "finance") {
    const amortizations = apportion(
      toUnits(rouAsset),
      new Array<number>(args.periods).fill(1),
    ).map(fromUnits);
    schedule = accretion.map((line, i) => ({ ...line, amortization: amortizations[i]! }));
  } else {
    const totalPayments = fromUnits(toUnits(args.payment) * BigInt(args.periods));
    const costs = apportion(
      toUnits(totalPayments),
      new Array<number>(args.periods).fill(1),
    ).map(fromUnits);
    // Continue-from-opening: the carried ROU generally differs from the
    // stated liability (unamortised costs in the outgoing system), so the
    // cost-minus-interest shape is level-shifted by the apportioned
    // difference. The shift sums exactly to that difference, hence the
    // adjustments retire exactly the stated ROU. Skipped when the figures
    // coincide so un-onboarded measurement stays bit-identical.
    const rouDelta = add(rouAsset, neg(liability));
    const shift = cmp(rouDelta, "0") === 0
      ? null
      : apportion(toUnits(rouDelta), new Array<number>(args.periods).fill(1)).map(fromUnits);
    schedule = accretion.map((line, i) => ({
      ...line,
      singleCost: costs[i]!,
      rouAdjustment: shift ? add(add(costs[i]!, neg(line.interest)), shift[i]!) : add(costs[i]!, neg(line.interest)),
    }));
    // Invariant: the ROU adjustments must consume the asset exactly.
    const consumed = sum(schedule.map((l) => l.rouAdjustment!));
    if (cmp(consumed, rouAsset) !== 0) {
      throw new LeaseError(`operating schedule does not consume the right-of-use asset (${consumed} vs ${rouAsset})`);
    }
  }
  return { liability, rouAsset, schedule };
}

// ---------------------------------------------------------------------------
// Lessor arithmetic (pure)
// ---------------------------------------------------------------------------

export type LessorClassification = "sales_type" | "direct_financing" | "operating";

/**
 * Lessor classification (ASC 842-30-25-1 / IFRS 16.61-63): any
 * transfer-of-risks-and-rewards criterion met by the lease itself → sales-type
 * (a finance lease under IFRS). Failing that, ASC 842 classifies as DIRECT
 * FINANCING when the present value of the payments PLUS a third-party residual
 * value guarantee amounts to substantially all of the fair value — control
 * passes economically but not through the lease terms alone, so selling profit
 * is deferred rather than taken at commencement. Otherwise operating.
 */
export function classifyLessorLease(
  inputs: LeaseClassificationInputs & { thirdPartyResidualGuaranteePv?: string },
): { classification: LessorClassification; criteria: string[] } {
  const asLessee = classifyLease(inputs, "us_gaap");
  assertClassificationDecimal(inputs.thirdPartyResidualGuaranteePv, "third-party residual guarantee");
  if (asLessee.model === "finance") {
    return { classification: "sales_type", criteria: asLessee.criteria };
  }
  if (
    inputs.thirdPartyResidualGuaranteePv != null &&
    inputs.pvOfPayments != null &&
    inputs.fairValue != null &&
    cmp(inputs.fairValue, "0") > 0
  ) {
    const threshold = inputs.pvThresholdPercent ?? "90";
    const combined = add(inputs.pvOfPayments, inputs.thirdPartyResidualGuaranteePv);
    const lhs = toUnits(combined) * 100n * 10_000n;
    const rhs = toUnits(inputs.fairValue) * toUnits(threshold);
    if (lhs >= rhs) {
      return {
        classification: "direct_financing",
        criteria: ["pv-plus-third-party-guarantee-substantially-all"],
      };
    }
  }
  return { classification: "operating", criteria: asLessee.criteria };
}

/**
 * Lessor commencement for the two financing classifications (ASC 842-30-25-1,
 * 30-30-1/2):
 *  - sales-type: derecognise the asset, recognise the net investment, and take
 *    selling profit (or loss) immediately;
 *  - direct financing: selling PROFIT is deferred — presented as a reduction
 *    of the net investment and earned into income over the term through the
 *    discount rate — while a selling LOSS is recognised immediately.
 * Balanced by construction either way.
 */
export function lessorCommencement(args: {
  classification: Exclude<LessorClassification, "operating">;
  netInvestment: string;
  carryingAmount: string;
  accounts: {
    netInvestmentAccountId: string;
    assetAccountId: string;
    sellingProfitAccountId: string;
    /** Contra to net investment; required for direct financing with a profit. */
    deferredProfitAccountId?: string;
  };
}): { sellingProfit: string; deferredProfit: string; lines: { accountId: string; amount: string }[] } {
  const profit = add(args.netInvestment, neg(args.carryingAmount));
  const isProfit = cmp(profit, "0") > 0;

  if (args.classification === "sales_type" || !isProfit) {
    const { sellingProfit, lines } = salesTypeCommencement({
      netInvestment: args.netInvestment,
      carryingAmount: args.carryingAmount,
      accounts: args.accounts,
    });
    return { sellingProfit, deferredProfit: "0.0000", lines };
  }

  if (!args.accounts.deferredProfitAccountId) {
    throw new LeaseError("direct financing with a selling profit requires a deferred-profit account");
  }
  const lines = [
    { accountId: args.accounts.netInvestmentAccountId, amount: args.netInvestment },
    { accountId: args.accounts.assetAccountId, amount: neg(args.carryingAmount) },
    { accountId: args.accounts.deferredProfitAccountId, amount: neg(profit) },
  ];
  const residual = lines.reduce((a, l) => add(a, l.amount), "0");
  if (!isZero(residual)) throw new LeaseError(`direct-financing commencement does not balance (${residual})`);
  return { sellingProfit: "0.0000", deferredProfit: fromUnits(toUnits(profit)), lines };
}

export interface LessorLevelledPeriod {
  sequence: number;
  billed: string;
  income: string;
  /** Accrual movement for the period: income − billed (positive = accrue). */
  accrualDelta: string;
  cumulativeAccrual: string;
}

/**
 * Straight-line an escalating operating-lease rent stream (IFRS 16.81 /
 * ASC 842-30-25-11): income is level regardless of the billing pattern, and
 * the cumulative accrual (a rent receivable when billing lags, deferred rent
 * when billing leads) returns to exactly zero at the end of the term.
 */
export function lessorStraightLineSchedule(billedPayments: string[]): LessorLevelledPeriod[] {
  if (billedPayments.length === 0) throw new LeaseError("no payments to level");
  const total = billedPayments.reduce((a, p) => a + toUnits(p), 0n);
  const incomes = apportion(total, new Array<number>(billedPayments.length).fill(1)).map(fromUnits);
  let cumulative = "0";
  return billedPayments.map((billed, i) => {
    const income = incomes[i]!;
    const accrualDelta = add(income, neg(billed));
    cumulative = add(cumulative, accrualDelta);
    if (i === billedPayments.length - 1 && !isZero(cumulative)) {
      throw new LeaseError(`levelled schedule does not return to zero (residual ${cumulative})`);
    }
    return { sequence: i + 1, billed, income, accrualDelta, cumulativeAccrual: cumulative };
  });
}

/**
 * Sales-type commencement (ASC 842-30-25-1(b), 30-1): derecognise the
 * underlying asset, recognise the net investment in the lease at the PV of the
 * payments (+ any guaranteed residual, out of v1 scope), and take selling
 * profit = net investment − carrying amount immediately. Balanced by
 * construction; a loss debits the profit account.
 */
export function salesTypeCommencement(args: {
  netInvestment: string;
  carryingAmount: string;
  accounts: { netInvestmentAccountId: string; assetAccountId: string; sellingProfitAccountId: string };
}): { sellingProfit: string; lines: { accountId: string; amount: string }[] } {
  const profit = add(args.netInvestment, neg(args.carryingAmount));
  const lines = [
    { accountId: args.accounts.netInvestmentAccountId, amount: args.netInvestment },
    { accountId: args.accounts.assetAccountId, amount: neg(args.carryingAmount) },
  ];
  if (!isZero(profit)) lines.push({ accountId: args.accounts.sellingProfitAccountId, amount: neg(profit) });
  const residual = lines.reduce((a, l) => add(a, l.amount), "0");
  if (!isZero(residual)) throw new LeaseError(`sales-type commencement does not balance (${residual})`);
  return { sellingProfit: profit, lines };
}

// ---------------------------------------------------------------------------
// Service (database)
// ---------------------------------------------------------------------------

const FREQUENCY_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };
const PERIODS_PER_YEAR: Record<string, number> = { monthly: 12, quarterly: 4, annual: 1 };

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d!, lastDay);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day)).toISOString().slice(0, 10);
}
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * Advance-timing schedules are not implemented yet, and measureLesseeLease
 * refuses them at commencement. Front-load that refusal to creation so an
 * agreement that could never be measured fails validation instead of surfacing
 * only when it commences — the measurement guard stays as defense in depth.
 */
export function assertLeaseTimingSupported(timing: "arrears" | "advance"): void {
  if (timing === "advance") {
    throw new LeaseError(
      "advance-timing payment schedules are not implemented yet — create the agreement with arrears timing",
    );
  }
}

/**
 * Longest supported lease horizon, in months: 100 years. Coordinated with
 * revenue's MAX_FINANCING_DEFERRAL_YEARS = 100 — the supported financing
 * horizon, not a statutory calendar rule. Commencement builds one schedule
 * row per period, so terms beyond this hang or OOM before posting anything.
 */
export const MAX_LEASE_TERM_MONTHS = 1200;

/** Shared calendar-date gate: the storage layer would reject garbage with a
 *  raw `invalid input syntax for type date` instead of a domain error. Uses
 *  the engine's ISO calendar policy (padded YYYY-MM-DD, real date, years
 *  0001–9999) — no local parser. */
export function assertLeaseCommencementOn(value: unknown): void {
  if (!isIsoCalendarDate(value)) {
    throw new LeaseError("commencement date must be a calendar date (YYYY-MM-DD)");
  }
}

/**
 * Shared term gate for creation AND commencement. Creation validates the
 * request; commencement re-validates the STORED term/frequency because legacy
 * rows persisted before the creation guard (the database only checks
 * `term_periods > 0`) would otherwise allocate unbounded boundary arrays and
 * schedule rows — including on the exempt path, which never reaches the
 * present-value measurement guard. Returns the frequency's month count.
 */
export function assertLeaseTermWithinHorizon(termPeriods: unknown, paymentFrequency: unknown): number {
  const frequencyMonths =
    typeof paymentFrequency === "string" ? FREQUENCY_MONTHS[paymentFrequency] : undefined;
  if (!frequencyMonths) {
    throw new LeaseError("payment frequency must be one of monthly, quarterly, annual");
  }
  if (!Number.isSafeInteger(termPeriods) || (termPeriods as number) < 1) {
    throw new LeaseError("lease term must be a positive whole number of periods");
  }
  // Division first: termPeriods is only known to be a safe integer, and
  // termPeriods × frequencyMonths can overflow into unsafe-integer range.
  if ((termPeriods as number) > MAX_LEASE_TERM_MONTHS / frequencyMonths) {
    throw new LeaseError(
      `lease term exceeds the supported 100-year horizon (${MAX_LEASE_TERM_MONTHS} months)`,
    );
  }
  return frequencyMonths;
}

export interface CreateLeaseInput {
  subsidiaryId: string;
  leaseNumber: string;
  description?: string | null;
  commencementOn: string;
  termPeriods: number;
  paymentFrequency: "monthly" | "quarterly" | "annual";
  paymentTiming?: "arrears" | "advance";
  paymentAmount: string;
  annualDiscountRatePercent: string;
  classificationInputs?: LeaseClassificationInputs;
  /** Election; validated against eligibility for short_term. */
  exemption?: "short_term" | "low_value" | null;
  /**
   * Continue-from-opening onboarding (migration 0156): the liability and
   * right-of-use carrying amounts measured through the cutover as-of date in
   * the outgoing system. Commencement then schedules only the remaining
   * periods from these figures and posts no commencement journal.
   */
  openingBalances?: { liability: string; rouCarrying: string; asOf: string } | null;
  accounts: {
    rouAsset: string;
    leaseLiability: string;
    interestExpense: string;
    amortizationExpense: string;
    leaseExpense: string;
    payment: string;
  };
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
}

/** Create a draft lease agreement with its framework-resolved classification. */
export async function createLeaseAgreement(
  orgId: string,
  actorId: string | null,
  input: CreateLeaseInput,
): Promise<{ leaseId: string; classification: LeaseClassification }> {
  const framework = await orgReportingFramework(orgId);
  const classificationInputs = input.classificationInputs ?? {};
  const classification = classifyLease(classificationInputs, framework);

  // Fail closed on measurement inputs before touching the database: without
  // these, impossible terms/payments/rates/dates fall through to raw storage
  // errors (check-constraint violations, invalid date syntax) instead of a
  // domain LeaseError, and unbounded terms hang commencement (PV summation,
  // apportion weights, and schedule rows all scale with the period count).
  // The term gate is shared with commencement (legacy stored terms).
  const frequencyMonths = assertLeaseTermWithinHorizon(input.termPeriods, input.paymentFrequency);
  assertLeaseCommencementOn(input.commencementOn);

  if (input.exemption === "short_term") {
    const months = input.termPeriods * frequencyMonths;
    if (
      !shortTermExemptionEligible({
        leaseTermMonths: months,
        purchaseOptionReasonablyCertain: classificationInputs.purchaseOptionReasonablyCertain,
      })
    ) {
      throw new LeaseError(
        "short-term exemption requires a term of twelve months or less with no purchase option reasonably certain to be exercised",
      );
    }
  }
  assertLeaseTimingSupported(input.paymentTiming ?? "arrears");

  // Continue-from-opening validation (migration 0156): an exempt lease
  // recognises no balances, so carry-in figures with an exemption election
  // are contradictory; the as-of date is the cutover — it cannot precede the
  // commencement the remaining term is counted from.
  const openingBalances = input.openingBalances ?? null;
  if (openingBalances) {
    if (input.exemption) {
      throw new LeaseError("exempt leases recognise no asset or liability — omit the opening balances");
    }
    assertLeaseCommencementOn(openingBalances.asOf);
    if (openingBalances.asOf < input.commencementOn) {
      throw new LeaseError("opening balances as-of date cannot precede the commencement date");
    }
  }
  const openingLiability = openingBalances ? exactMoney(openingBalances.liability, "Opening liability") : null;
  const openingRouCarrying = openingBalances ? exactMoney(openingBalances.rouCarrying, "Opening right-of-use carrying amount") : null;
  if (openingLiability !== null && cmp(openingLiability, "0") < 0) {
    throw new LeaseError("Opening liability must be non-negative");
  }
  if (openingRouCarrying !== null && cmp(openingRouCarrying, "0") < 0) {
    throw new LeaseError("Opening right-of-use carrying amount must be non-negative");
  }

  const paymentAmount = exactMoney(input.paymentAmount, "Payment amount");
  if (cmp(paymentAmount, "0") <= 0) {
    throw new LeaseError("Payment amount must be positive");
  }
  // payment_amount is numeric(19,4): fifteen whole digits. The format check
  // admits any magnitude, so a pasted 20-digit amount died in Postgres with a
  // storage error. Fail closed with the same named refusal.
  if (paymentAmount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new LeaseError("Payment amount exceeds the supported ledger magnitude");
  }
  const annualDiscountRatePercent = persistLeaseAnnualDiscountRate(input.annualDiscountRatePercent);
  // annual_discount_rate_percent is numeric(19,10): nine whole digits.
  if (annualDiscountRatePercent.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 9) {
    throw new LeaseError("annual discount rate exceeds the supported ledger magnitude");
  }
  if (cmp(annualDiscountRatePercent, "0") < 0) {
    throw new LeaseError("annual discount rate must be non-negative");
  }
  const leaseId = randomUUID();
  await db.execute(sql`
    insert into lease_agreements
      (id, org_id, subsidiary_id, lease_number, description, status, commencement_on, term_periods,
       payment_frequency, payment_timing, payment_amount, annual_discount_rate_percent,
       classification, classification_inputs, exemption,
       opening_liability, opening_rou_carrying, opening_balances_as_of,
       rou_asset_account_id, lease_liability_account_id, interest_expense_account_id,
       amortization_expense_account_id, lease_expense_account_id, payment_account_id,
       department_id, project_id, location_id, custom, created_by, updated_by)
    values (${leaseId}, ${orgId}, ${input.subsidiaryId}, ${input.leaseNumber}, ${input.description ?? null},
            'draft', ${input.commencementOn}, ${input.termPeriods},
            ${input.paymentFrequency}, ${input.paymentTiming ?? "arrears"}, ${paymentAmount},
            ${annualDiscountRatePercent}, ${classification.model},
            ${JSON.stringify({ ...classificationInputs, resolvedCriteria: classification.criteria, framework })}::jsonb,
            ${input.exemption ?? null},
            ${openingLiability}, ${openingRouCarrying}, ${openingBalances?.asOf ?? null},
            ${input.accounts.rouAsset}, ${input.accounts.leaseLiability}, ${input.accounts.interestExpense},
            ${input.accounts.amortizationExpense}, ${input.accounts.leaseExpense}, ${input.accounts.payment},
            ${input.departmentId ?? null}, ${input.projectId ?? null}, ${input.locationId ?? null},
            '{}'::jsonb, ${actorId}, ${actorId})`);
  return { leaseId, classification };
}
type LeaseRow = {
  id: string;
  subsidiary_id: string;
  lease_number: string;
  status: string;
  commencement_on: string;
  term_periods: number;
  payment_frequency: string;
  payment_timing: "arrears" | "advance";
  payment_amount: string;
  annual_discount_rate_percent: string;
  classification: "finance" | "operating";
  exemption: string | null;
  initial_liability: string | null;
  initial_rou_asset: string | null;
  opening_liability: string | null;
  opening_rou_carrying: string | null;
  opening_balances_as_of: string | null;
  rou_asset_account_id: string;
  lease_liability_account_id: string;
  interest_expense_account_id: string;
  amortization_expense_account_id: string;
  lease_expense_account_id: string;
  payment_account_id: string;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  commencement_entry_id: string | null;
};

async function leaseRow(orgId: string, leaseId: string, runner: SqlExecutor): Promise<LeaseRow> {
  const r = (await runner.execute<LeaseRow>(sql`
    select id, subsidiary_id, lease_number, status, commencement_on::text as commencement_on, term_periods,
           payment_frequency, payment_timing, payment_amount::text as payment_amount,
           annual_discount_rate_percent::text as annual_discount_rate_percent,
           classification, exemption, initial_liability::text as initial_liability,
           initial_rou_asset::text as initial_rou_asset,
           opening_liability::text as opening_liability,
           opening_rou_carrying::text as opening_rou_carrying,
           opening_balances_as_of::text as opening_balances_as_of,
           rou_asset_account_id, lease_liability_account_id, interest_expense_account_id,
           amortization_expense_account_id, lease_expense_account_id, payment_account_id,
           department_id, project_id, location_id, commencement_entry_id
      from lease_agreements where org_id = ${orgId} and id = ${leaseId} for update`));
  const row = r.rows[0];
  if (!row) throw new LeaseError("lease not found");
  return row;
}

async function postingContext(runner: SqlExecutor, orgId: string, subsidiaryId: string, date: string) {
  const r = (await runner.execute<{ book_id: string | null; period_id: string | null; currency: string | null }>(sql`
    select (select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl limit 1 for share) as book_id,
           (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
              and starts_on <= ${date} and ends_on >= ${date} limit 1 for share) as period_id,
           (select base_currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}) as currency
  `));
  const row = r.rows[0];
  if (!row?.book_id) throw new LeaseError("no active primary posting book");
  if (!row.period_id) throw new LeaseError(`no accounting period covers ${date}`);
  if (!row.currency) throw new LeaseError("subsidiary not found");
  return { bookId: row.book_id, periodId: row.period_id, currency: row.currency };
}

async function assertLeaseAccountsPostable(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  accountIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(accountIds)];
  if (!ids.length) return;
  const accounts = (await tx.execute<{
    id: string;
    is_active: boolean;
    is_summary: boolean;
  }>(sql`
    select id, is_active, is_summary
      from accounts
     where org_id=${orgId} and id=any(${uuidArray(ids)}::uuid[])
     for share
  `)).rows;
  const byId = new Map(accounts.map((account) => [account.id, account]));
  if (ids.some((id) => {
    const account = byId.get(id);
    return !account || !account.is_active || account.is_summary;
  })) {
    throw new LeaseError("lease posting requires active, non-summary accounts");
  }
}

/**
 * Application-level companion to the je_guard Postgres gate (which refuses
 * the draft→posted flip in a GL-closed period): fail fast with a named
 * LeaseError instead of dying at the flip with a raw driver error. GL is
 * always implied; leases post on the primary book for one legal entity.
 */
async function assertLeasePeriodOpen(
  tx: Pick<typeof db, "execute">,
  args: { orgId: string; periodId: string; bookId: string; subsidiaryId: string },
): Promise<void> {
  try {
    await assertPeriodModulesOpen(tx, {
      orgId: args.orgId,
      periodId: args.periodId,
      bookId: args.bookId,
      subsidiaryIds: [args.subsidiaryId],
      modules: [],
    });
  } catch (error) {
    if (error instanceof CloseError) throw new LeaseError(error.message);
    throw error;
  }
}

async function postLeaseEntry(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    lease: LeaseRow;
    date: string;
    entryNumber: string;
    memo: string;
    lines: { accountId: string; amount: string }[];
    actorId: string | null;
  },
): Promise<string> {
  const residual = args.lines.reduce((a, l) => add(a, l.amount), "0");
  if (!isZero(residual)) throw new LeaseError(`lease entry does not balance (${residual})`);
  // Apply the same native legal-entity policy as other posting workflows. Hold
  // the hierarchy and referenced configuration throughout validation and writes.
  await tx.execute(sql`select id from subsidiaries where org_id=${args.orgId} order by id for share`);
  await assertLeaseAccountsPostable(tx, args.orgId, args.lines.map((line) => line.accountId));
  const dimensions = [
    { table: "departments", id: args.lease.department_id },
    { table: "projects", id: args.lease.project_id },
    { table: "locations", id: args.lease.location_id },
  ] as const;
  for (const dimension of dimensions) {
    if (!dimension.id) continue;
    await tx.execute(sql`select id from ${sql.raw(dimension.table)}
      where org_id=${args.orgId} and id=${dimension.id} for share`);
  }
  await validateSubsidiaryRestrictions(tx, {
    orgId: args.orgId,
    ctx: await loadSubsidiaryContext(tx, args.orgId),
    docSubsidiaryId: args.lease.subsidiary_id,
    lines: args.lines.map((line) => ({
      ...line,
      subsidiaryId: args.lease.subsidiary_id,
      departmentId: args.lease.department_id,
      projectId: args.lease.project_id,
      locationId: args.lease.location_id,
    })),
  });
  const ctx = await postingContext(tx, args.orgId, args.lease.subsidiary_id, args.date);
  // Refuse here with a named error: the je_guard backstop would reject the
  // flip below with a raw driver error instead.
  await assertLeasePeriodOpen(tx, {
    orgId: args.orgId,
    periodId: ctx.periodId,
    bookId: ctx.bookId,
    subsidiaryId: args.lease.subsidiary_id,
  });
  const entry = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${args.orgId}, ${ctx.bookId}, ${args.lease.subsidiary_id}, ${args.entryNumber}, ${args.date},
            ${ctx.periodId}, ${args.memo}, 'draft', 'lease', ${args.actorId}, ${args.actorId})
    returning id`));
  const entryId = entry.rows[0]!.id;
  let lineNumber = 1;
  for (const line of args.lines) {
    if (isZero(line.amount)) continue;
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
         department_id, project_id, location_id, memo)
      values (${args.orgId}, ${entryId}, ${lineNumber}, ${line.accountId}, ${args.lease.subsidiary_id},
              ${line.amount}, ${ctx.currency}, ${line.amount}, 1,
              ${args.lease.department_id}, ${args.lease.project_id}, ${args.lease.location_id}, ${args.memo})`);
    lineNumber++;
  }
  await tx.execute(sql`
    update journal_entries set status = 'posted', posted_at = now(), posted_by = ${args.actorId}
     where id = ${entryId} and org_id = ${args.orgId}`);
  return entryId;
}

export interface CommenceResult {
  leaseId: string;
  liability: string;
  rouAsset: string;
  commencementEntryId: string | null;
  periods: number;
}

/**
 * Commence a draft lease: measure liability and right-of-use asset, persist
 * the full schedule, post the commencement entry (DR ROU / CR liability), and
 * activate. An exempt lease recognises nothing at commencement — its schedule
 * carries the payments for straight-line expensing. Idempotent: an active
 * lease returns its existing measurement.
 */
export async function commenceLease(
  orgId: string,
  leaseId: string,
  actorId: string | null,
): Promise<CommenceResult> {
  return db.transaction(async (tx) => {
    const lease = await leaseRow(orgId, leaseId, tx);
    if (lease.status === "active") {
      return {
        leaseId,
        liability: lease.initial_liability ?? "0",
        rouAsset: lease.initial_rou_asset ?? lease.initial_liability ?? "0",
        commencementEntryId: lease.commencement_entry_id,
        periods: lease.term_periods,
      };
    }
    if (lease.status !== "draft") throw new LeaseError(`lease ${lease.lease_number} is ${lease.status}`);

    // Continue-from-opening onboarding (migration 0156): the storage check
    // guarantees all-or-none, so a half-set row can only come from a writer
    // that bypassed it — fail closed rather than measuring half a carry-in.
    const openingFields = [lease.opening_liability, lease.opening_rou_carrying, lease.opening_balances_as_of];
    if (openingFields.some((f) => f === null) && openingFields.some((f) => f !== null)) {
      throw new LeaseError("opening balances require a liability, a right-of-use carrying amount, and an as-of date together");
    }
    const opening = lease.opening_liability !== null
      ? {
          liability: lease.opening_liability,
          rouCarrying: lease.opening_rou_carrying!,
          asOf: lease.opening_balances_as_of!,
        }
      : null;
    if (opening) {
      if (lease.exemption) {
        throw new LeaseError("exempt leases recognise no asset or liability — omit the opening balances");
      }
      if (opening.asOf < lease.commencement_on) {
        throw new LeaseError("opening balances as-of date cannot precede the commencement date");
      }
    }

    // Re-validate the STORED term/frequency before ANY commencement loop: a
    // legacy row persisted before the creation guard can carry a huge term
    // (the database only checks term_periods > 0), and the boundary loop and
    // the exempt schedule loop below never reach the measurement guard.
    const frequencyMonths = assertLeaseTermWithinHorizon(lease.term_periods, lease.payment_frequency);
    const periodsPerYear = PERIODS_PER_YEAR[lease.payment_frequency]!;

    // Period boundaries: period i covers [start + i·f months, next boundary).
    const boundaries: { start: string; end: string; dueOn: string }[] = [];
    for (let i = 0; i < lease.term_periods; i++) {
      const start = addMonths(lease.commencement_on, i * frequencyMonths);
      const end = addDays(addMonths(lease.commencement_on, (i + 1) * frequencyMonths), -1);
      const dueOn = lease.payment_timing === "advance" ? start : end;
      boundaries.push({ start, end, dueOn });
    }

    if (lease.exemption) {
      // Off balance sheet: schedule rows carry the payments; nothing posts now.
      for (let i = 0; i < lease.term_periods; i++) {
        const b = boundaries[i]!;
        await tx.execute(sql`
          insert into lease_agreement_schedule_lines
            (id, org_id, lease_id, sequence, due_on, period_start, period_end,
             opening_liability, payment, interest, principal, closing_liability, single_cost,
             created_by, updated_by)
          values (${randomUUID()}, ${orgId}, ${leaseId}, ${i + 1}, ${b.dueOn}, ${b.start}, ${b.end},
                  '0', ${lease.payment_amount}, '0', '0', '0', ${lease.payment_amount},
                  ${actorId}, ${actorId})`);
      }
      await tx.execute(sql`
        update lease_agreements
           set status = 'active', initial_liability = '0', initial_rou_asset = '0',
               updated_at = now(), updated_by = ${actorId}
         where id = ${leaseId} and org_id = ${orgId}`);
      return { leaseId, liability: "0", rouAsset: "0", commencementEntryId: null, periods: lease.term_periods };
    }

    // Continue-from-opening (migration 0156): only periods ending after the
    // cutover schedule — earlier periods lived in the outgoing system and
    // must never be caught up. The full-term sequence numbering continues so
    // the remaining rows read as periods k..n of n.
    const remaining = opening
      ? boundaries.map((b, i) => ({ ...b, index: i })).filter((b) => b.end > opening.asOf)
      : boundaries.map((b, i) => ({ ...b, index: i }));
    if (opening && remaining.length === 0) {
      throw new LeaseError(
        `opening balances as-of ${opening.asOf} fall past the end of the lease term — no periods remain to continue`,
      );
    }

    const measurement = measureLesseeLease({
      payment: lease.payment_amount,
      periods: remaining.length,
      annualRatePercent: lease.annual_discount_rate_percent,
      periodsPerYear,
      timing: lease.payment_timing,
      model: lease.classification,
      ...(opening ? { openingLiability: opening.liability, openingRouAsset: opening.rouCarrying } : {}),
    });

    for (let i = 0; i < measurement.schedule.length; i++) {
      const line = measurement.schedule[i]!;
      const b = remaining[i]!;
      await tx.execute(sql`
        insert into lease_agreement_schedule_lines
          (id, org_id, lease_id, sequence, due_on, period_start, period_end,
           opening_liability, payment, interest, principal, closing_liability,
           amortization, single_cost, rou_adjustment, created_by, updated_by)
        values (${randomUUID()}, ${orgId}, ${leaseId}, ${b.index + 1}, ${b.dueOn}, ${b.start}, ${b.end},
                ${line.opening}, ${line.payment}, ${line.interest}, ${fromUnits(toUnits(line.payment) - toUnits(line.interest))},
                ${line.closing}, ${line.amortization ?? null}, ${line.singleCost ?? null},
                ${line.rouAdjustment ?? null}, ${actorId}, ${actorId})`);
    }

    // An onboarded lease carries its GL balances in through the opening
    // trial-balance import: booking the commencement here would double-count
    // them. The subledger ties to those balances through initial_liability /
    // initial_rou_asset instead.
    if (opening) {
      await tx.execute(sql`
        update lease_agreements
           set status = 'active', initial_liability = ${opening.liability},
               initial_rou_asset = ${opening.rouCarrying}, commencement_entry_id = null,
               updated_at = now(), updated_by = ${actorId}
         where id = ${leaseId} and org_id = ${orgId}`);
      return {
        leaseId,
        liability: opening.liability,
        rouAsset: opening.rouCarrying,
        commencementEntryId: null,
        periods: lease.term_periods,
      };
    }

    const entryId = await postLeaseEntry(tx, {
      orgId,
      lease,
      date: lease.commencement_on,
      entryNumber: `LEASE-${lease.lease_number}`,
      memo: `Lease commencement — ${lease.lease_number}`,
      lines: [
        { accountId: lease.rou_asset_account_id, amount: measurement.rouAsset },
        { accountId: lease.lease_liability_account_id, amount: neg(measurement.liability) },
      ],
      actorId,
    });

    await tx.execute(sql`
      update lease_agreements
         set status = 'active', initial_liability = ${measurement.liability},
             initial_rou_asset = ${measurement.rouAsset}, commencement_entry_id = ${entryId},
             updated_at = now(), updated_by = ${actorId}
       where id = ${leaseId} and org_id = ${orgId}`);

    return {
      leaseId,
      liability: measurement.liability,
      rouAsset: measurement.rouAsset,
      commencementEntryId: entryId,
      periods: lease.term_periods,
    };
  });
}

type LeaseSchedulePostingRow = {
  line_id: string;
  lease_id: string;
  sequence: number;
  due_on: string;
  payment: string;
  interest: string;
  principal: string;
  amortization: string | null;
  single_cost: string | null;
  rou_adjustment: string | null;
};

export interface PostLeaseScheduleResult {
  posted: number;
  skipped: number;
  entries: { leaseId: string; sequence: number; entryIds: string[] }[];
}

/**
 * Post every due, unposted schedule line across the org's active leases as of
 * `asOfDate`. Idempotent: a line with a payment entry is never reposted.
 *
 * Finance model, per period: payment entry (DR interest expense, DR liability
 * principal / CR payment account) and amortization entry (DR ROU amortization
 * / CR ROU asset). Operating model (842-20-25-6): one entry — DR single lease
 * cost, DR liability principal / CR payment account, CR ROU adjustment.
 * Exempt lease: DR lease expense / CR payment account.
 */
export async function postDueLeaseSchedules(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
): Promise<PostLeaseScheduleResult> {
  if (!isIsoCalendarDate(asOfDate)) {
    throw new LeaseError("as-of date must be a valid calendar date (YYYY-MM-DD)");
  }
  const due = (await db.execute<{ line_id: string; lease_id: string }>(sql`
    select l.id as line_id, l.lease_id
      from lease_agreement_schedule_lines l
      join lease_agreements a on a.id = l.lease_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and a.status = 'active'
       and l.due_on <= ${asOfDate} and l.payment_entry_id is null
     order by l.due_on, l.sequence`));

  const result: PostLeaseScheduleResult = { posted: 0, skipped: 0, entries: [] };
  for (const candidate of due.rows) {
    const outcome = await db.transaction(async (tx) => {
      // Claim the aggregate first, then reload the due line. Discovery is not
      // a posting snapshot: another runner may have completed it while we wait.
      const theLease = await leaseRow(orgId, candidate.lease_id, tx);
      if (theLease.status !== "active") return { status: "skipped" as const };
      const line = (await tx.execute<LeaseSchedulePostingRow>(sql`
        select l.id as line_id, l.lease_id, l.sequence, l.due_on::text as due_on,
               l.payment::text as payment, l.interest::text as interest, l.principal::text as principal,
               l.amortization::text as amortization, l.single_cost::text as single_cost,
               l.rou_adjustment::text as rou_adjustment
          from lease_agreement_schedule_lines l
         where l.id=${candidate.line_id} and l.lease_id=${candidate.lease_id} and l.org_id=${orgId}
           and l.due_on <= ${asOfDate} and l.payment_entry_id is null for update`)).rows[0];
      if (!line) return { status: "skipped" as const };
      // A locked period skips its lines the way the depreciation and revenue
      // runners skip theirs: the run keeps posting open periods instead of
      // dying on the first locked one. assertLeasePeriodOpen raises LeaseError
      // only for the closed refusal, so catching it here is precise — any
      // other failure still aborts the run. A missing period is not a skip:
      // postingContext above refuses it the way it always has.
      const postCtx = await postingContext(tx, orgId, theLease.subsidiary_id, line.due_on);
      try {
        await assertLeasePeriodOpen(tx, {
          orgId,
          periodId: postCtx.periodId,
          bookId: postCtx.bookId,
          subsidiaryId: theLease.subsidiary_id,
        });
      } catch (error) {
        if (error instanceof LeaseError) return { status: "period_closed" as const };
        throw error;
      }
      const entryIds: string[] = [];
      const tag = `${theLease.lease_number}-${line.sequence}`;

      if (theLease.exemption) {
        entryIds.push(
          await postLeaseEntry(tx, {
            orgId,
            lease: theLease,
            date: line.due_on,
            entryNumber: `LEASE-${tag}`,
            memo: `Lease payment (exempt) — ${tag}`,
            lines: [
              { accountId: theLease.lease_expense_account_id, amount: line.payment },
              { accountId: theLease.payment_account_id, amount: neg(line.payment) },
            ],
            actorId,
          }),
        );
      } else if (theLease.classification === "finance") {
        entryIds.push(
          await postLeaseEntry(tx, {
            orgId,
            lease: theLease,
            date: line.due_on,
            entryNumber: `LEASE-${tag}`,
            memo: `Lease payment — ${tag}`,
            lines: [
              { accountId: theLease.interest_expense_account_id, amount: line.interest },
              { accountId: theLease.lease_liability_account_id, amount: line.principal },
              { accountId: theLease.payment_account_id, amount: neg(line.payment) },
            ],
            actorId,
          }),
        );
        entryIds.push(
          await postLeaseEntry(tx, {
            orgId,
            lease: theLease,
            date: line.due_on,
            entryNumber: `LEASE-AM-${tag}`,
            memo: `Right-of-use amortization — ${tag}`,
            lines: [
              { accountId: theLease.amortization_expense_account_id, amount: line.amortization! },
              { accountId: theLease.rou_asset_account_id, amount: neg(line.amortization!) },
            ],
            actorId,
          }),
        );
      } else {
        entryIds.push(
          await postLeaseEntry(tx, {
            orgId,
            lease: theLease,
            date: line.due_on,
            entryNumber: `LEASE-${tag}`,
            memo: `Operating lease cost — ${tag}`,
            lines: [
              { accountId: theLease.lease_expense_account_id, amount: line.single_cost! },
              { accountId: theLease.lease_liability_account_id, amount: line.principal },
              { accountId: theLease.payment_account_id, amount: neg(line.payment) },
              { accountId: theLease.rou_asset_account_id, amount: neg(line.rou_adjustment!) },
            ],
            actorId,
          }),
        );
      }

      await tx.execute(sql`
        update lease_agreement_schedule_lines
           set payment_entry_id = ${entryIds[0]!},
               amortization_entry_id = ${entryIds[1] ?? null},
               posted_at = now(), updated_at = now(), updated_by = ${actorId}
         where id = ${line.line_id} and org_id = ${orgId} and payment_entry_id is null`);

      return { status: "posted" as const, leaseId: line.lease_id, sequence: line.sequence, entryIds };
    });
    if (outcome.status === "posted") {
      result.posted++;
      result.entries.push({ leaseId: outcome.leaseId, sequence: outcome.sequence, entryIds: outcome.entryIds });
    } else {
      result.skipped++;
    }
  }
  return result;
}
