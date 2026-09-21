/**
 * Pub 946 / Rev. Proc. 89-15 short-tax-year dates and subsequent-year
 * recovery. A calendar MACRS schedule scaled by a factor or months/12 is
 * not either published method.
 *
 * https://www.irs.gov/publications/p946
 */

import {
  add,
  cmp,
  formatMoney,
  mulDecimal,
  mulRatio,
  neg,
  normalizeDecimal,
  normalizeMoney,
  roundDiv,
  roundMoney,
  toUnits,
} from "../money/money.ts";
import { compareDecimal } from "../money/exact-decimal.ts";

export class MacrsShortYearError extends Error {
  readonly name = "MacrsShortYearError";
}

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** Derived from adjacent statutory windows, never an operator election.
 * Rev. Proc. 89-15 §4.01(1)(a)(i) allocates a shared calendar month to
 * the second short year for the half-year convention. */
export interface MacrsShortYearContext {
  excludedTerminalMonth?: boolean;
}

/** Exact recovery time. Rev. Proc. 89-15 §4.02–4.03 uses months including
 * fractions, separately from §4.01's convention-date determination. Keep
 * those fractions intact until they reach the existing money arithmetic.
 * Signed differences are allowed here; deduction inputs are nonnegative. */
export type MacrsMonths = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;
export type MacrsMonthsInput = MacrsMonths | number;

export function macrsMonthRatio(
  numerator: bigint,
  denominator = 1n,
): MacrsMonths {
  if (
    typeof numerator !== "bigint" ||
    typeof denominator !== "bigint" ||
    denominator <= 0n
  ) {
    throw new MacrsShortYearError(
      "MACRS month fractions require integer units and a positive denominator",
    );
  }
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

/** Existing whole/half-month callers remain exact. Other fractions must be
 * explicit rationals, never a rounded or binary floating-point month count. */
export function macrsMonths(value: MacrsMonthsInput): MacrsMonths {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value * 2)) {
      throw new MacrsShortYearError(
        "MACRS fractional months require an exact numerator and denominator; numeric months must be whole or half months",
      );
    }
    return macrsMonthRatio(BigInt(value * 2), 2n);
  }
  if (!value || typeof value !== "object") {
    throw new MacrsShortYearError(
      "MACRS months require a whole/half count or an exact fraction",
    );
  }
  return macrsMonthRatio(value.numerator, value.denominator);
}

export function addMacrsMonths(
  left: MacrsMonthsInput,
  right: MacrsMonthsInput,
): MacrsMonths {
  const a = macrsMonths(left);
  const b = macrsMonths(right);
  return macrsMonthRatio(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subtractMacrsMonths(
  left: MacrsMonthsInput,
  right: MacrsMonthsInput,
): MacrsMonths {
  const b = macrsMonths(right);
  return addMacrsMonths(left, {
    numerator: -b.numerator,
    denominator: b.denominator,
  });
}

export function compareMacrsMonths(
  left: MacrsMonthsInput,
  right: MacrsMonthsInput,
): -1 | 0 | 1 {
  const a = macrsMonths(left);
  const b = macrsMonths(right);
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function minMacrsMonths(
  first: MacrsMonthsInput,
  ...rest: MacrsMonthsInput[]
): MacrsMonths {
  return rest.reduce<MacrsMonths>(
    (smallest, value) =>
      compareMacrsMonths(value, smallest) < 0 ? macrsMonths(value) : smallest,
    macrsMonths(first),
  );
}

export function maxMacrsMonths(
  first: MacrsMonthsInput,
  ...rest: MacrsMonthsInput[]
): MacrsMonths {
  return rest.reduce<MacrsMonths>(
    (largest, value) =>
      compareMacrsMonths(value, largest) > 0 ? macrsMonths(value) : largest,
    macrsMonths(first),
  );
}

function nonnegativeMonths(value: MacrsMonthsInput): MacrsMonths {
  const months = macrsMonths(value);
  if (months.numerator < 0n)
    throw new MacrsShortYearError("MACRS recovery months cannot be negative");
  return months;
}

export function parseCalendarDay(value: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function formatCalendarDay(day: CalendarDay): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function startsOnFirst(day: CalendarDay): boolean {
  return day.day === 1;
}

function endsOnLast(day: CalendarDay): boolean {
  return day.day === lastDayOfMonth(day.year, day.month);
}

function utc(day: CalendarDay): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day));
}

function fromUtc(date: Date): CalendarDay {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function taxYearWindow(yearStart: string, yearEnd: string) {
  const start = parseCalendarDay(yearStart);
  const end = parseCalendarDay(yearEnd);
  if (!start || !end) {
    throw new MacrsShortYearError(
      "MACRS requires calendar yearStart and yearEnd (YYYY-MM-DD)",
    );
  }
  if (utc(end) < utc(start)) {
    throw new MacrsShortYearError(
      `MACRS window ${yearStart}–${yearEnd} ends before it starts`,
    );
  }
  return { start, end };
}

function rateRatio(numerator: bigint, denominator: bigint): string {
  const scale = 10_000_000_000n;
  const units = roundDiv(numerator * scale, denominator);
  return `${units / scale}.${String(units % scale).padStart(10, "0")}`;
}

export function inclusiveDayCount(
  start: CalendarDay,
  end: CalendarDay,
): number {
  return (
    Math.round((utc(end).getTime() - utc(start).getTime()) / 86_400_000) + 1
  );
}

export function addCalendarDays(start: CalendarDay, days: number): CalendarDay {
  const date = utc(start);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/** §4.01 HY convention midpoint month count, NOT a deduction numerator.
 * Day-based windows use halfYearDeemedServiceDate; recovery uses Exact. */
export function shortTaxYearMonths(
  yearStart: string,
  yearEnd: string,
  context?: MacrsShortYearContext,
): number {
  const start = parseCalendarDay(yearStart);
  const end = parseCalendarDay(yearEnd);
  if (!start || !end) {
    throw new MacrsShortYearError(
      "short-year MACRS requires calendar yearStart and yearEnd (YYYY-MM-DD)",
    );
  }
  if (utc(end) < utc(start)) {
    throw new MacrsShortYearError(
      `short-year window ${yearStart}–${yearEnd} ends before it starts`,
    );
  }
  if (
    context?.excludedTerminalMonth &&
    (!startsOnFirst(start) || endsOnLast(end))
  ) {
    throw new MacrsShortYearError(
      "a shared terminal month requires a month-based short year ending within that month; derive the exclusion from consecutive statutory windows",
    );
  }
  if (!startsOnFirst(start) && !endsOnLast(end)) {
    throw new MacrsShortYearError(
      `MACRS window ${yearStart}–${yearEnd} needs its actual-day convention midpoint and exact recovery months; a whole-month estimate cannot represent these boundaries`,
    );
  }
  const beginMonth = start.month;
  const beginYear = start.year;
  const months = (end.year - beginYear) * 12 + (end.month - beginMonth) + 1;
  if (months < 1 || months > 12) {
    throw new MacrsShortYearError(
      `short-year MACRS computed ${months} months from ${yearStart} to ${yearEnd}; expected 1-12`,
    );
  }
  return months - (context?.excludedTerminalMonth ? 1 : 0);
}

/** Calendar months from the beginning of start's month through the actual
 * inclusive end, less the elapsed part of the first month. The denominator
 * belongs to each calendar month; leap February is never a 30-day month. */
function calendarMonthSpan(
  start: CalendarDay,
  end: CalendarDay,
  firstElapsed: MacrsMonths,
): MacrsMonths {
  if (utc(end) < utc(start)) return macrsMonths(0);
  const whole = (end.year - start.year) * 12 + end.month - start.month;
  return maxMacrsMonths(
    0,
    subtractMacrsMonths(
      addMacrsMonths(
        whole,
        macrsMonthRatio(
          BigInt(end.day),
          BigInt(lastDayOfMonth(end.year, end.month)),
        ),
      ),
      firstElapsed,
    ),
  );
}

/** Actual dated period for the §4.03 recovery numerator. This deliberately
 * differs from the touched-month count used by §4.01 to locate a half-year
 * convention midpoint. Start/end days are legal boundaries, not deemed
 * midpoint dates. Partial calendar months retain their own day denominator. */
export function shortTaxYearMonthsExact(
  yearStart: string,
  yearEnd: string,
  context?: MacrsShortYearContext,
): MacrsMonths {
  const { start, end } = taxYearWindow(yearStart, yearEnd);
  if (context?.excludedTerminalMonth) {
    // Preserve the existing applicability check: this exclusion comes from
    // consecutive month-based HY windows, not an arbitrary operator flag.
    shortTaxYearMonths(yearStart, yearEnd, context);
  }
  const months = calendarMonthSpan(
    start,
    end,
    macrsMonthRatio(
      BigInt(start.day - 1),
      BigInt(lastDayOfMonth(start.year, start.month)),
    ),
  );
  if (compareMacrsMonths(months, 12) > 0) {
    throw new MacrsShortYearError(
      `short-year MACRS window ${yearStart}–${yearEnd} exceeds twelve months`,
    );
  }
  return months;
}

/** §4.02 service numerator after applying the convention. A deemed 15th
 * means exactly half a month; an actual partial year-end still contributes
 * only its fraction. In particular a February 20 year-end is not all of
 * February merely because the deemed service date is a first or midpoint. */
export function monthsTreatedInServiceExact(
  deemed: CalendarDay,
  yearEnd: string,
  context?: MacrsShortYearContext,
): MacrsMonths {
  const end = parseCalendarDay(yearEnd);
  if (!end || !parseCalendarDay(formatCalendarDay(deemed))) {
    throw new MacrsShortYearError(
      "MACRS service requires a valid deemed date and calendar year-end",
    );
  }
  if (context?.excludedTerminalMonth && endsOnLast(end)) {
    throw new MacrsShortYearError(
      "a terminal month ending on its last day cannot be shared with the next statutory window",
    );
  }
  const elapsed =
    deemed.day === 15
      ? macrsMonthRatio(1n, 2n)
      : macrsMonthRatio(
          BigInt(deemed.day - 1),
          BigInt(lastDayOfMonth(deemed.year, deemed.month)),
        );
  // §4.01's shared-month rule selected the convention date. It does not
  // move the legal year-end for §4.02's deduction numerator. Otherwise the
  // excluded month would lose its days before the next tax year begins.
  return calendarMonthSpan(deemed, end, elapsed);
}

export function impliedShortYearFactor(
  yearStart: string,
  yearEnd: string,
  context?: MacrsShortYearContext,
): string {
  const months = shortTaxYearMonthsExact(yearStart, yearEnd, context);
  return rateRatio(months.numerator, months.denominator * 12n);
}

export function isFullCalendarYear(
  yearStart: string,
  yearEnd: string,
): boolean {
  const start = parseCalendarDay(yearStart);
  const end = parseCalendarDay(yearEnd);
  return (
    !!start &&
    !!end &&
    start.day === 1 &&
    start.month === 1 &&
    end.month === 12 &&
    end.day === 31 &&
    start.year === end.year
  );
}

/** Pub 946: a short tax year is fewer than 12 full months. A July–June
 *  fiscal year is a full year even though it is not a calendar year. */
export function isFullTaxYear(yearStart: string, yearEnd: string): boolean {
  const { start, end } = taxYearWindow(yearStart, yearEnd);
  // Counting a partly occupied January as a month for the half-year
  // convention does not make January 15–December 31 twelve FULL months.
  return (
    startsOnFirst(start) &&
    endsOnLast(end) &&
    (end.year - start.year) * 12 + end.month - start.month === 11
  );
}

export function isShortTaxYear(yearStart: string, yearEnd: string): boolean {
  return !isFullTaxYear(yearStart, yearEnd);
}

export function factorsAgree(declared: string, implied: string): boolean {
  return compareDecimal(normalizeDecimal(declared, 10), implied) === 0;
}

export function assertShortYearFactorAgrees(
  yearStart: string,
  yearEnd: string,
  declared?: string | number | null,
  context?: MacrsShortYearContext,
): string {
  const months = shortTaxYearMonthsExact(yearStart, yearEnd, context);
  const implied = impliedShortYearFactor(yearStart, yearEnd, context);
  if (declared == null || String(declared).trim() === "") return implied;
  const exact = normalizeDecimal(declared, 10);
  if (!factorsAgree(exact, implied)) {
    throw new MacrsShortYearError(
      `short-year factor ${exact} does not match ${yearStart}–${yearEnd} (${months.numerator}/${months.denominator} months divided by 12); pass the dates and matching factor, do not scale a calendar schedule`,
    );
  }
  return implied;
}

function nearestPrecedingFirstOrMidpoint(day: CalendarDay): CalendarDay {
  if (day.day === 1 || day.day === 15) return day;
  if (day.day < 15) return { year: day.year, month: day.month, day: 1 };
  return { year: day.year, month: day.month, day: 15 };
}

function addMonthsFirst(start: CalendarDay, months: number): CalendarDay {
  const monthIndex = start.month - 1 + months;
  const year = start.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  return { year, month, day: 1 };
}

/** Half-year deemed placed-in-service date (Pub 946 short-year rules). */
export function halfYearDeemedServiceDate(
  yearStart: string,
  yearEnd: string,
  context?: MacrsShortYearContext,
): CalendarDay {
  const { start, end } = taxYearWindow(yearStart, yearEnd);
  if (context?.excludedTerminalMonth)
    shortTaxYearMonths(yearStart, yearEnd, context);
  if (startsOnFirst(start) || endsOnLast(end)) {
    const months = shortTaxYearMonths(yearStart, yearEnd, context);
    const origin = { year: start.year, month: start.month, day: 1 };
    if (months % 2 === 0) return addMonthsFirst(origin, months / 2);
    return { ...addMonthsFirst(origin, Math.floor(months / 2)), day: 15 };
  }
  const days = inclusiveDayCount(start, end);
  const midpoint = addCalendarDays(start, Math.ceil(days / 2) - 1);
  return nearestPrecedingFirstOrMidpoint(midpoint);
}

/** Mid-quarter deemed placed-in-service date for a short year (Pub 946 table). */
export function midQuarterDeemedServiceDate(
  yearStart: string,
  yearEnd: string,
  placedOn: string,
): CalendarDay {
  const { start, end } = taxYearWindow(yearStart, yearEnd);
  const placed = parseCalendarDay(placedOn);
  if (!placed) {
    throw new MacrsShortYearError(
      "placedInServiceOn must be a calendar date (YYYY-MM-DD)",
    );
  }
  if (placedOn < yearStart || placedOn > yearEnd) {
    throw new MacrsShortYearError(
      "the date used for a MACRS quarter must be within its tax-year window",
    );
  }
  const months = (end.year - start.year) * 12 + end.month - start.month + 1;
  // Pub 946 explicitly uses whole calendar months for 4- and 8-month
  // short years. A full fiscal year uses its four three-month quarters.
  if (startsOnFirst(start) && endsOnLast(end) && [4, 8, 12].includes(months)) {
    const quarterMonths = months / 4;
    const monthOffset =
      (placed.year - start.year) * 12 + placed.month - start.month;
    const quarter = Math.floor(monthOffset / quarterMonths);
    return {
      ...addMonthsFirst(
        start,
        quarter * quarterMonths + Math.floor(quarterMonths / 2),
      ),
      day: quarterMonths % 2 === 0 ? 1 : 15,
    };
  }
  const days = inclusiveDayCount(start, end);
  const offset = Math.max(0, inclusiveDayCount(start, placed) - 1);
  // Rev. Proc. 89-15 table 2 assigns a 31-day December to days 1–8,
  // 9–15, 16–23, and 24–31. Classify the whole calendar day by its
  // midpoint; using midnight (offset * 4 / days) puts December 16 in Q2
  // and falsely deems it placed on December 1 instead of December 15.
  const quarter = Math.min(3, Math.floor(((offset * 2 + 1) * 2) / days));
  const firstQuarterDay = Math.ceil((days * quarter) / 4 - 0.5) + 1;
  const lastQuarterDay = Math.ceil((days * (quarter + 1)) / 4 - 0.5);
  const midpoint = addCalendarDays(
    start,
    Math.ceil((firstQuarterDay + lastQuarterDay) / 2) - 1,
  );
  return nearestPrecedingFirstOrMidpoint(midpoint);
}

export function midMonthDeemedServiceDate(placedOn: string): CalendarDay {
  const placed = parseCalendarDay(placedOn);
  if (!placed) {
    throw new MacrsShortYearError(
      "placedInServiceOn must be a calendar date (YYYY-MM-DD)",
    );
  }
  return { year: placed.year, month: placed.month, day: 15 };
}

export function deemedPlacedInServiceOn(
  convention: "half_year" | "mid_quarter" | "mid_month",
  yearStart: string,
  yearEnd: string,
  placedOn: string,
  context?: MacrsShortYearContext,
): CalendarDay {
  if (context?.excludedTerminalMonth && convention !== "half_year") {
    throw new MacrsShortYearError(
      "the shared-month half-year context must not change a mid-quarter or mid-month convention",
    );
  }
  if (convention === "half_year")
    return halfYearDeemedServiceDate(yearStart, yearEnd, context);
  if (convention === "mid_quarter")
    return midQuarterDeemedServiceDate(yearStart, yearEnd, placedOn);
  return midMonthDeemedServiceDate(placedOn);
}

/** Compatibility adapter for callers whose duration is a whole or half
 * month. It must not truncate an actual partial month; such callers use the
 * exact helper and retain its rational throughout financial arithmetic. */
export function monthsTreatedInService(
  deemed: CalendarDay,
  yearEnd: string,
  context?: MacrsShortYearContext,
): number {
  const exact = monthsTreatedInServiceExact(deemed, yearEnd, context);
  const halfUnits = exact.numerator * 2n;
  if (halfUnits % exact.denominator !== 0n) {
    throw new MacrsShortYearError(
      "MACRS service through this partial year-end requires exact month fractions; use monthsTreatedInServiceExact rather than rounding to a whole or half month",
    );
  }
  return Number(halfUnits / exact.denominator) / 2;
}

export function decliningBalanceRate(
  method: "200_db" | "150_db" | "straight_line",
  recoveryPeriodYears: string,
): string {
  const yearUnits = toUnits(normalizeMoney(recoveryPeriodYears));
  if (yearUnits <= 0n) {
    throw new MacrsShortYearError("recovery period must be greater than 0");
  }
  const factorNum = method === "200_db" ? 2n : method === "150_db" ? 3n : 1n;
  const factorDen = method === "150_db" ? 2n : 1n;
  return rateRatio(factorNum * 10_000n, factorDen * yearUnits);
}

export function shortYearPlacementDeduction(args: {
  basis: string;
  rate: string;
  monthsInService: MacrsMonthsInput;
}): string {
  const months = nonnegativeMonths(args.monthsInService);
  const fullYear = mulDecimal(args.basis, args.rate);
  return formatMoney(
    roundMoney(
      mulRatio(fullYear, months.numerator, months.denominator * 12n),
      2,
    ),
    2,
  );
}

export function subsequentSimplifiedDeduction(args: {
  adjustedBasis: string;
  rate: string;
  monthsInYear: MacrsMonthsInput;
}): string {
  const months = nonnegativeMonths(args.monthsInYear);
  const annual = mulDecimal(args.adjustedBasis, args.rate);
  if (compareMacrsMonths(months, 12) >= 0)
    return formatMoney(roundMoney(annual, 2), 2);
  return formatMoney(
    roundMoney(mulRatio(annual, months.numerator, months.denominator * 12n), 2),
    2,
  );
}

export function recoveryMonthsFromYears(recoveryPeriodYears: string): number {
  return Number(
    formatMoney(
      roundMoney(mulDecimal(normalizeMoney(recoveryPeriodYears), "12"), 0),
      0,
    ),
  );
}

/** DB vs remaining-life SL. The applicable rate after a short year still
 *  switches; a fixed declining-balance rate on adjusted basis is not enough. */
export function applicableAnnualDeduction(args: {
  adjustedBasis: string;
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  remainingMonths: MacrsMonthsInput;
}): string {
  const remaining = nonnegativeMonths(args.remainingMonths);
  if (remaining.numerator === 0n || cmp(args.adjustedBasis, "0") <= 0)
    return "0.00";
  const sl = mulRatio(
    args.adjustedBasis,
    12n * remaining.denominator,
    remaining.numerator,
  );
  if (args.method === "straight_line") return formatMoney(roundMoney(sl, 2), 2);
  const declining = mulDecimal(
    args.adjustedBasis,
    decliningBalanceRate(args.method, args.recoveryPeriodYears),
  );
  return formatMoney(
    roundMoney(cmp(sl, declining) >= 0 ? sl : declining, 2),
    2,
  );
}

function annualForRecoveryYear(args: {
  originalMacrsBasis: string;
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  recoveryYearIndex: number;
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  if (args.recoveryYearIndex * 12 >= recoveryMonths) return "0.00";
  const rate = decliningBalanceRate(args.method, args.recoveryPeriodYears);
  // Rev. Proc. 89-15 §4.03(1), (3): allocate the declining-balance
  // recovery years first. The switch to straight line is evaluated on the
  // TAXABLE year's opening adjusted basis, not within these recovery years.
  // Table 3's fourth taxable year is 12.00, not an allocation of recovery
  // years that have independently switched to straight line.
  if (args.method === "straight_line") {
    return mulDecimal(args.originalMacrsBasis, rate);
  }
  let basis = persistExact(args.originalMacrsBasis);
  for (let year = 0; year < args.recoveryYearIndex; year += 1) {
    basis = persistExact(add(basis, neg(mulDecimal(basis, rate))));
  }
  return mulDecimal(basis, rate);
}

function persistExact(value: string): string {
  return formatMoney(value, 4);
}

/** Allocate the unswitched recovery-year amounts. The caller compares this
 * with straight line on the taxable year's adjusted basis (§4.03(3)). */
export function allocationRecoveryDeduction(args: {
  originalMacrsBasis: string;
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  elapsedMonths: MacrsMonthsInput;
  monthsThisYear: MacrsMonthsInput;
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  let elapsed = nonnegativeMonths(args.elapsedMonths);
  let remaining = maxMacrsMonths(
    0,
    minMacrsMonths(
      nonnegativeMonths(args.monthsThisYear),
      subtractMacrsMonths(recoveryMonths, elapsed),
    ),
  );
  let total = "0";
  while (
    compareMacrsMonths(remaining, 0) > 0 &&
    compareMacrsMonths(elapsed, recoveryMonths) < 0
  ) {
    // Only the integral recovery-year index becomes a Number for the loop.
    // Recovery time and the fractions multiplying money remain BigInt.
    const yearIndex = elapsed.numerator / (12n * elapsed.denominator);
    const intoYear = subtractMacrsMonths(
      elapsed,
      macrsMonthRatio(yearIndex * 12n),
    );
    const chunk = minMacrsMonths(
      subtractMacrsMonths(12, intoYear),
      remaining,
      subtractMacrsMonths(recoveryMonths, elapsed),
    );
    const annual = annualForRecoveryYear({
      originalMacrsBasis: args.originalMacrsBasis,
      method: args.method,
      recoveryPeriodYears: args.recoveryPeriodYears,
      recoveryYearIndex: Number(yearIndex),
    });
    total = add(
      total,
      mulRatio(annual, chunk.numerator, chunk.denominator * 12n),
    );
    remaining = subtractMacrsMonths(remaining, chunk);
    elapsed = addMacrsMonths(elapsed, chunk);
  }
  return formatMoney(roundMoney(total, 2), 2);
}

export function subsequentRecoveryDeduction(args: {
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  originalMacrsBasis: string;
  adjustedBasis: string;
  elapsedMonths: MacrsMonthsInput;
  monthsThisYear: MacrsMonthsInput;
  shortYearMethod: "simplified" | "allocation";
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  const elapsed = nonnegativeMonths(args.elapsedMonths);
  const remainingMonths = subtractMacrsMonths(recoveryMonths, elapsed);
  const requested = nonnegativeMonths(args.monthsThisYear);
  if (compareMacrsMonths(remainingMonths, 0) <= 0) return "0.00";
  const serviceMonths = minMacrsMonths(requested, remainingMonths, 12);
  if (args.shortYearMethod === "allocation") {
    const allocated = allocationRecoveryDeduction({
      originalMacrsBasis: args.originalMacrsBasis,
      method: args.method,
      recoveryPeriodYears: args.recoveryPeriodYears,
      elapsedMonths: args.elapsedMonths,
      monthsThisYear: args.monthsThisYear,
    });
    const straightLine = mulRatio(
      args.adjustedBasis,
      serviceMonths.numerator * remainingMonths.denominator,
      serviceMonths.denominator * remainingMonths.numerator,
    );
    const deduction =
      args.method === "straight_line" || cmp(straightLine, allocated) > 0
        ? straightLine
        : allocated;
    return formatMoney(
      roundMoney(
        cmp(deduction, args.adjustedBasis) > 0 ? args.adjustedBasis : deduction,
        2,
      ),
      2,
    );
  }
  const annual = applicableAnnualDeduction({
    adjustedBasis: args.adjustedBasis,
    method: args.method,
    recoveryPeriodYears: args.recoveryPeriodYears,
    remainingMonths,
  });
  const deduction = mulRatio(
    annual,
    serviceMonths.numerator,
    serviceMonths.denominator * 12n,
  );
  return formatMoney(
    roundMoney(
      cmp(deduction, args.adjustedBasis) > 0 ? args.adjustedBasis : deduction,
      2,
    ),
    2,
  );
}

export function remainingAfter(basis: string, deduction: string): string {
  const next = add(basis, neg(deduction));
  return formatMoney(cmp(next, "0") < 0 ? "0" : next, 2);
}
