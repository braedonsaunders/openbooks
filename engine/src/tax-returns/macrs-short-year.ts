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
  fromUnits,
  mulDecimal,
  mulRatio,
  neg,
  normalizeDecimal,
  normalizeMoney,
  roundDiv,
  roundMoney,
  toUnits,
} from "../money/money.ts";

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
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function inclusiveDayCount(start: CalendarDay, end: CalendarDay): number {
  return Math.round((utc(end).getTime() - utc(start).getTime()) / 86_400_000) + 1;
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
    throw new MacrsShortYearError("short-year MACRS requires calendar yearStart and yearEnd (YYYY-MM-DD)");
  }
  if (utc(end) < utc(start)) {
    throw new MacrsShortYearError(`short-year window ${yearStart}–${yearEnd} ends before it starts`);
  }
  if (!startsOnFirst(start) && !endsOnLast(end)) {
    const days = inclusiveDayCount(start, end);
    if (days < 1) {
      throw new MacrsShortYearError(`short-year window ${yearStart}–${yearEnd} has no days`);
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

export function impliedShortYearFactor(yearStart: string, yearEnd: string): string {
  const months = shortTaxYearMonths(yearStart, yearEnd);
  if (months === 12 && isFullCalendarYear(yearStart, yearEnd)) return normalizeDecimal(1, 10);
  return normalizeDecimal(mulRatio("1.0000", BigInt(months), 12n), 10);
}

export function isFullCalendarYear(yearStart: string, yearEnd: string): boolean {
  const start = parseCalendarDay(yearStart);
  const end = parseCalendarDay(yearEnd);
  return !!start && !!end && start.day === 1 && start.month === 1 && end.month === 12 && end.day === 31 && start.year === end.year;
}

/** Pub 946: a short tax year is fewer than 12 full months. A July–June
 *  fiscal year is a full year even though it is not a calendar year. */
export function isFullTaxYear(yearStart: string, yearEnd: string): boolean {
  return shortTaxYearMonths(yearStart, yearEnd) === 12;
}

export function isShortTaxYear(yearStart: string, yearEnd: string): boolean {
  return !isFullTaxYear(yearStart, yearEnd);
}

export function factorsAgree(declared: string, implied: string): boolean {
  return cmp(normalizeDecimal(declared, 10), implied) === 0;
}

export function assertShortYearFactorAgrees(yearStart: string, yearEnd: string, declared?: string | number | null): string {
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
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  return { year, month, day: 1 };
}

/** Half-year deemed placed-in-service date (Pub 946 short-year rules). */
export function halfYearDeemedServiceDate(yearStart: string, yearEnd: string): CalendarDay {
  const start = parseCalendarDay(yearStart)!;
  const end = parseCalendarDay(yearEnd)!;
  if (startsOnFirst(start) || endsOnLast(end)) {
    const months = shortTaxYearMonths(yearStart, yearEnd);
    const origin = { year: start.year, month: start.month, day: 1 };
    if (months % 2 === 0) return addMonthsFirst(origin, months / 2);
    return { ...addMonthsFirst(origin, Math.floor(months / 2)), day: 15 };
  }
  const days = inclusiveDayCount(start, end);
  const midpoint = addCalendarDays(start, Math.floor(days / 2));
  return nearestPrecedingFirstOrMidpoint(midpoint);
}

/** Mid-quarter deemed placed-in-service date for a short year (Pub 946 table). */
export function midQuarterDeemedServiceDate(yearStart: string, yearEnd: string, placedOn: string): CalendarDay {
  const start = parseCalendarDay(yearStart)!;
  const placed = parseCalendarDay(placedOn);
  if (!placed) {
    throw new MacrsShortYearError("placedInServiceOn must be a calendar date (YYYY-MM-DD)");
  }
  const days = inclusiveDayCount(start, parseCalendarDay(yearEnd)!);
  const quarterDays = days / 4;
  const offset = Math.max(0, inclusiveDayCount(start, placed) - 1);
  const quarter = Math.min(3, Math.floor(offset / quarterDays));
  const quarterStart = addCalendarDays(start, Math.round(quarter * quarterDays));
  const midpoint = addCalendarDays(quarterStart, Math.floor(quarterDays / 2));
  return nearestPrecedingFirstOrMidpoint(midpoint);
}

export function midMonthDeemedServiceDate(placedOn: string): CalendarDay {
  const placed = parseCalendarDay(placedOn);
  if (!placed) {
    throw new MacrsShortYearError("placedInServiceOn must be a calendar date (YYYY-MM-DD)");
  }
  return { year: placed.year, month: placed.month, day: 15 };
}

export function deemedPlacedInServiceOn(
  convention: "half_year" | "mid_quarter" | "mid_month",
  yearStart: string,
  yearEnd: string,
  placedOn: string,
): CalendarDay {
  if (convention === "half_year") return halfYearDeemedServiceDate(yearStart, yearEnd);
  if (convention === "mid_quarter") return midQuarterDeemedServiceDate(yearStart, yearEnd, placedOn);
  return midMonthDeemedServiceDate(placedOn);
}

/** Months treated as in service from the deemed date through year-end, including parts of a month. */
export function monthsTreatedInService(deemed: CalendarDay, yearEnd: string): number {
  const end = parseCalendarDay(yearEnd)!;
  if (utc(end) < utc(deemed)) return 0;
  return (end.year - deemed.year) * 12 + (end.month - deemed.month) + 1;
}

export function decliningBalanceRate(method: "200_db" | "150_db" | "straight_line", recoveryPeriodYears: string): string {
  const yearUnits = toUnits(normalizeMoney(recoveryPeriodYears));
  if (yearUnits <= 0n) {
    throw new MacrsShortYearError("recovery period must be greater than 0");
  }
  const factorNum = method === "200_db" ? 2n : method === "150_db" ? 3n : 1n;
  const factorDen = method === "150_db" ? 2n : 1n;
  return normalizeDecimal(fromUnits(roundDiv(factorNum * 10_000n * 10_000n, factorDen * yearUnits)), 10);
}

export function shortYearPlacementDeduction(args: {
  basis: string;
  rate: string;
  monthsInService: number;
}): string {
  const fullYear = mulDecimal(args.basis, args.rate);
  return formatMoney(roundMoney(mulRatio(fullYear, BigInt(args.monthsInService), 12n), 2), 2);
}

export function subsequentSimplifiedDeduction(args: {
  adjustedBasis: string;
  rate: string;
  monthsInYear: number;
}): string {
  const annual = mulDecimal(args.adjustedBasis, args.rate);
  if (args.monthsInYear >= 12) return formatMoney(roundMoney(annual, 2), 2);
  return formatMoney(roundMoney(mulRatio(annual, BigInt(args.monthsInYear), 12n), 2), 2);
}

export function recoveryMonthsFromYears(recoveryPeriodYears: string): number {
  return Number(formatMoney(roundMoney(mulDecimal(normalizeMoney(recoveryPeriodYears), "12"), 0), 0));
}

/** DB vs remaining-life SL. The applicable rate after a short year still
 *  switches; a fixed declining-balance rate on adjusted basis is not enough. */
export function applicableAnnualDeduction(args: {
  adjustedBasis: string;
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  remainingMonths: number;
}): string {
  if (args.remainingMonths <= 0 || cmp(args.adjustedBasis, "0") <= 0) return "0.00";
  const sl = mulRatio(args.adjustedBasis, 12n, BigInt(args.remainingMonths));
  if (args.method === "straight_line") return formatMoney(roundMoney(sl, 2), 2);
  const declining = mulDecimal(args.adjustedBasis, decliningBalanceRate(args.method, args.recoveryPeriodYears));
  return formatMoney(roundMoney(cmp(sl, declining) >= 0 ? sl : declining, 2), 2);
}

function annualForRecoveryYear(args: {
  originalMacrsBasis: string;
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  recoveryYearIndex: number;
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  let basis = persistExact(args.originalMacrsBasis);
  for (let year = 0; year < args.recoveryYearIndex; year += 1) {
    const remaining = recoveryMonths - year * 12;
    const annual = applicableAnnualDeduction({
      adjustedBasis: basis,
      method: args.method,
      recoveryPeriodYears: args.recoveryPeriodYears,
      remainingMonths: remaining,
    });
    basis = remainingAfter(basis, annual);
  }
  return applicableAnnualDeduction({
    adjustedBasis: basis,
    method: args.method,
    recoveryPeriodYears: args.recoveryPeriodYears,
    remainingMonths: recoveryMonths - args.recoveryYearIndex * 12,
  });
}

function persistExact(value: string): string {
  return formatMoney(value, 4);
}

/** Allocation applies every year after a short year — not only the follow year. */
export function allocationRecoveryDeduction(args: {
  originalMacrsBasis: string;
  method: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears: string;
  elapsedMonths: number;
  monthsThisYear: number;
}): string {
  const recoveryMonths = recoveryMonthsFromYears(args.recoveryPeriodYears);
  let remaining = Math.max(0, Math.min(args.monthsThisYear, recoveryMonths - args.elapsedMonths));
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
    total = add(total, mulRatio(annual, BigInt(chunk), 12n));
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
  if (args.shortYearMethod === "allocation") {
    return allocationRecoveryDeduction({
      originalMacrsBasis: args.originalMacrsBasis,
      method: args.method,
      recoveryPeriodYears: args.recoveryPeriodYears,
      elapsedMonths: args.elapsedMonths,
      monthsThisYear: args.monthsThisYear,
    });
  }
  const annual = applicableAnnualDeduction({
    adjustedBasis: args.adjustedBasis,
    method: args.method,
    recoveryPeriodYears: args.recoveryPeriodYears,
    remainingMonths,
  });
  if (args.monthsThisYear >= 12) return annual;
  return formatMoney(roundMoney(mulRatio(annual, BigInt(args.monthsThisYear), 12n), 2), 2);
}

export function remainingAfter(basis: string, deduction: string): string {
  const next = add(basis, neg(deduction));
  return formatMoney(cmp(next, "0") < 0 ? "0" : next, 2);
}
