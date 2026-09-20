import { mulPercent, mulRatio, normalizeMoney } from "../../money/money.ts";
import { BenefitsError } from "./errors.ts";

/**
 * Pure benefits amount math (HR-8). All money crosses as exact decimal
 * STRINGS in the ledger's canonical numeric(19,4) representation; every
 * operation routes through engine/src/money/money.ts (bigint, halves away
 * from zero). Floating point never touches a benefit amount.
 *
 * No database, no clock: every function here is unit-tested without a
 * database, and no test doubles this module (a pure function has nothing
 * to isolate — mock the database, never this).
 */

export type BenefitCostBasis = "per_period" | "per_month" | "per_year" | "percent_of_pay";
export type BenefitProrationBasis = "full_month" | "daily";

const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COVERAGE_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function dayNumber(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function fromDayNumber(jd: number): string {
  const a = jd + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function parseDay(date: string, label: string): number {
  const match = CIVIL_DATE_RE.exec(date);
  if (!match) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(date)} is not a civil date — use YYYY-MM-DD`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysIn = daysInMonth(year, month);
  if (day < 1 || day > daysIn) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(date)} is not a calendar day — ${year}-${String(month).padStart(2, "0")} has ${daysIn} days`,
    );
  }
  return dayNumber(year, month, day);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Add (or subtract) whole days to a civil date. */
export function addDaysCivil(date: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new BenefitsError("INVALID_INPUT", `day offset ${days} is not a whole number of days`);
  }
  return fromDayNumber(parseDay(date, "date") + days);
}

export interface MonthBounds {
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

/** First day, last day, and length of a coverage month (YYYY-MM). */
export function monthBounds(coverageMonth: string): MonthBounds {
  const match = COVERAGE_MONTH_RE.exec(coverageMonth);
  if (!match) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `coverage month ${JSON.stringify(coverageMonth)} is not a month — use YYYY-MM`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const days = daysInMonth(year, month);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: `${match[1]}-${pad(month)}-01`, to: `${match[1]}-${pad(month)}-${days}`, days };
}

/** Inclusive covered days of the overlap between two date ranges. */
export function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const start = Math.max(parseDay(aFrom, "range start"), parseDay(bFrom, "range start"));
  const end = Math.min(parseDay(aTo, "range end"), parseDay(bTo, "range end"));
  return end >= start ? end - start + 1 : 0;
}

/** Whether an enrolment window [effectiveFrom, effectiveTo ?? open] touches a coverage month. */
export function enrollmentTouchesMonth(
  effectiveFrom: string,
  effectiveTo: string | null,
  month: MonthBounds,
): boolean {
  const start = parseDay(effectiveFrom, "effective_from");
  const end = effectiveTo === null ? Number.POSITIVE_INFINITY : parseDay(effectiveTo, "effective_to");
  if (end < start) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `effective_to ${effectiveTo} is before effective_from ${effectiveFrom} — end the enrolment on or after its start`,
    );
  }
  return start <= parseDay(month.to, "month end") && end >= parseDay(month.from, "month start");
}

function requireCanonicalMoney(amount: string, label: string): string {
  try {
    return normalizeMoney(amount);
  } catch {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(amount)} is not an exact decimal amount — record plain digits with at most 4 fraction digits, never separators or symbols`,
    );
  }
}

export interface MonthlyBasis {
  /** Org-declared periods per year from the employment's pay schedule. Null = unknown. */
  readonly periodsPerYear: number | null;
  /** Pay basis for percent_of_pay plans, supplied by the run. Null = not supplied. */
  readonly payBasis: string | null;
}

/**
 * The whole-month amount for a stored per-period election figure, by the
 * plan's cost basis. percent_of_pay resolves against the supplied pay basis;
 * per_period resolves against the employment's pay-schedule periods per
 * year. A missing input is a named refusal, never an assumed 12/24/26 and
 * never a guessed wage.
 */
export function monthlyFromBasis(
  amountPerPeriod: string,
  basis: BenefitCostBasis,
  opts: MonthlyBasis,
): string {
  if (
    basis !== "per_period" &&
    basis !== "per_month" &&
    basis !== "per_year" &&
    basis !== "percent_of_pay"
  ) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `cost basis ${JSON.stringify(basis)} is unknown — use per_period, per_month, per_year, or percent_of_pay`,
    );
  }
  const amount = requireCanonicalMoney(amountPerPeriod, "election amount");
  switch (basis) {
    case "per_month":
      return amount;
    case "per_year":
      return mulRatio(amount, 1n, 12n);
    case "per_period": {
      const ppy = opts.periodsPerYear;
      if (ppy === null || !Number.isInteger(ppy) || ppy <= 0) {
        throw new BenefitsError(
          "REFUSED",
          "the plan prices per pay period but the employment has no usable pay schedule — stamp the employee payroll profile with the pay schedule so periods per year is known; HR never assumes 12, 24, or 26",
        );
      }
      return mulRatio(amount, BigInt(ppy), 12n);
    }
    case "percent_of_pay": {
      if (opts.payBasis === null) {
        throw new BenefitsError(
          "REFUSED",
          "the plan prices percent of pay and the run has not supplied the pay basis — generation stops here by name instead of guessing a wage; supply the basis or elect a fixed-amount basis",
        );
      }
      const basisAmount = requireCanonicalMoney(opts.payBasis, "pay basis");
      return mulPercent(basisAmount, amount);
    }
  }
}

export interface ProrateInput {
  readonly monthlyAmount: string;
  readonly prorationBasis: BenefitProrationBasis;
  /** What the row covers (already clipped to the month and the enrolment). */
  readonly coveredFrom: string;
  readonly coveredTo: string;
  readonly month: MonthBounds;
}

/**
 * Apply the plan's required proration rule. full_month carries the whole
 * month whatever the covered slice; daily scales by covered days over days
 * in month, exact to the canonical cent. Payroll never prorates — this is
 * the only place a partial month is computed.
 */
export function prorateForMonth(input: ProrateInput): string {
  if (input.prorationBasis !== "full_month" && input.prorationBasis !== "daily") {
    throw new BenefitsError(
      "INVALID_INPUT",
      `proration basis ${JSON.stringify(input.prorationBasis)} is unknown — the plan must declare full_month or daily with no silent default`,
    );
  }
  const monthly = requireCanonicalMoney(input.monthlyAmount, "monthly amount");
  const covered = overlapDays(input.coveredFrom, input.coveredTo, input.month.from, input.month.to);
  if (covered <= 0) {
    throw new BenefitsError(
      "REFUSED",
      `covered ${input.coveredFrom}..${input.coveredTo} does not touch ${input.month.from}..${input.month.to} — nothing is owed for this month`,
    );
  }
  if (input.prorationBasis === "full_month") return monthly;
  return mulRatio(monthly, BigInt(covered), BigInt(input.month.days));
}

/** First date an employment satisfies a plan's waiting period. */
export function waitingEligibleDate(hireStart: string, waitingPeriodDays: number): string {
  if (!Number.isInteger(waitingPeriodDays) || waitingPeriodDays < 0) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `waiting period ${waitingPeriodDays} is not a non-negative whole number of days`,
    );
  }
  return addDaysCivil(hireStart, waitingPeriodDays);
}

export interface WindowShape {
  readonly kind: string;
  readonly opensOn: string;
  readonly closesOn: string;
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
}

/** Whether two windows of the same kind and scope overlap in time. */
export function windowsOverlap(a: WindowShape, b: WindowShape): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.employerSubsidiaryId ?? null) !== (b.employerSubsidiaryId ?? null)) return false;
  if ((a.departmentId ?? null) !== (b.departmentId ?? null)) return false;
  return overlapDays(a.opensOn, a.closesOn, b.opensOn, b.closesOn) > 0;
}

