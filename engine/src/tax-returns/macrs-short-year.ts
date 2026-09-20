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

/** Convention dates are firsts or midpoints. Keep half months as integer
 * periods before they multiply money; BigInt(3.5) would otherwise throw. */
function halfMonths(months: number): bigint {
  const periods = months * 2;
  if (!Number.isSafeInteger(periods) || periods < 0) {
    throw new MacrsShortYearError(
      "MACRS recovery months must be non-negative whole or half months",
    );
  }
  return BigInt(periods);
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

/** Pub 946 month count when the year starts on the 1st or ends on the last day. */
export function shortTaxYearMonths(yearStart: string, yearEnd: string): number {
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
  if (!startsOnFirst(start) && !endsOnLast(end)) {
    const days = inclusiveDayCount(start, end);
    if (days < 1) {
      throw new MacrsShortYearError(
        `short-year window ${yearStart}–${yearEnd} has no days`,
      );
    }
    return Math.max(1, Math.round(days / 30.4166));
  }
  const beginMonth = start.month;
  const beginYear = start.year;
  const months = (end.year - beginYear) * 12 + (end.month - beginMonth) + 1;
  if (months < 1 || months > 12) {
    throw new MacrsShortYearError(
      `short-year MACRS computed ${months} months from ${yearStart} to ${yearEnd}; expected 1-12`,
    );
  }
  return months;
}

export function impliedShortYearFactor(
  yearStart: string,
  yearEnd: string,
): string {
  const months = shortTaxYearMonths(yearStart, yearEnd);
  return rateRatio(halfMonths(months), 24n);
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
): string {
  const months = shortTaxYearMonths(yearStart, yearEnd);
  const implied = impliedShortYearFactor(yearStart, yearEnd);
  if (declared == null || String(declared).trim() === "") return implied;
  const exact = normalizeDecimal(declared, 10);
  if (!factorsAgree(exact, implied)) {
    throw new MacrsShortYearError(
      `short-year factor ${exact} does not match ${yearStart}–${yearEnd} (${months}/12); pass the dates and matching factor, do not scale a calendar schedule`,
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
): CalendarDay {
  const { start, end } = taxYearWindow(yearStart, yearEnd);
  if (startsOnFirst(start) || endsOnLast(end)) {
    const months = shortTaxYearMonths(yearStart, yearEnd);
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
): CalendarDay {
  if (convention === "half_year")
    return halfYearDeemedServiceDate(yearStart, yearEnd);
  if (convention === "mid_quarter")
    return midQuarterDeemedServiceDate(yearStart, yearEnd, placedOn);
  return midMonthDeemedServiceDate(placedOn);
}

/** Months treated as in service from the deemed date through year-end, including parts of a month. */
export function monthsTreatedInService(
  deemed: CalendarDay,
  yearEnd: string,
): number {
  const end = parseCalendarDay(yearEnd);
  if (
    !end ||
    !parseCalendarDay(formatCalendarDay(deemed)) ||
    ![1, 15].includes(deemed.day)
  ) {
    throw new MacrsShortYearError(
      "MACRS service requires a valid first-of-month or midpoint deemed date and a calendar year-end",
    );
  }
  if (utc(end) < utc(deemed)) return 0;
  return (
    (end.year - deemed.year) * 12 +
    (end.month - deemed.month) +
    1 -
    (deemed.day === 15 ? 0.5 : 0)
  );
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
  monthsInService: number;
}): string {
  const fullYear = mulDecimal(args.basis, args.rate);
  return formatMoney(
    roundMoney(mulRatio(fullYear, halfMonths(args.monthsInService), 24n), 2),
    2,
  );
}

export function subsequentSimplifiedDeduction(args: {
  adjustedBasis: string;
  rate: string;
  monthsInYear: number;
}): string {
  const annual = mulDecimal(args.adjustedBasis, args.rate);
  if (args.monthsInYear >= 12) return formatMoney(roundMoney(annual, 2), 2);
  return formatMoney(
    roundMoney(mulRatio(annual, halfMonths(args.monthsInYear), 24n), 2),
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
  remainingMonths: number;
}): string {
  if (args.remainingMonths <= 0 || cmp(args.adjustedBasis, "0") <= 0)
    return "0.00";
  const sl = mulRatio(
    args.adjustedBasis,
    24n,
    halfMonths(args.remainingMonths),
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
  elapsedMonths: number;
  monthsThisYear: number;
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  let remaining = Math.max(
    0,
    Math.min(args.monthsThisYear, recoveryMonths - args.elapsedMonths),
  );
  let elapsed = args.elapsedMonths;
  let total = "0";
  while (remaining > 0 && elapsed < recoveryMonths) {
    const intoYear = elapsed % 12;
    const chunk = Math.min(12 - intoYear, remaining, recoveryMonths - elapsed);
    const annual = annualForRecoveryYear({
      originalMacrsBasis: args.originalMacrsBasis,
      method: args.method,
      recoveryPeriodYears: args.recoveryPeriodYears,
      recoveryYearIndex: Math.floor(elapsed / 12),
    });
    total = add(total, mulRatio(annual, halfMonths(chunk), 24n));
    remaining -= chunk;
    elapsed += chunk;
  }
  return formatMoney(roundMoney(total, 2), 2);
}

export function subsequentRecoveryDeduction(args: {
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  originalMacrsBasis: string;
  adjustedBasis: string;
  elapsedMonths: number;
  monthsThisYear: number;
  shortYearMethod: "simplified" | "allocation";
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  const remainingMonths = recoveryMonths - args.elapsedMonths;
  if (remainingMonths <= 0) return "0.00";
  const serviceMonths = Math.min(args.monthsThisYear, remainingMonths, 12);
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
      halfMonths(serviceMonths),
      halfMonths(remainingMonths),
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
  const deduction = mulRatio(annual, halfMonths(serviceMonths), 24n);
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
