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

export function factorsAgree(declared: string, implied: string): boolean {
  return cmp(normalizeDecimal(declared, 10), implied) === 0;
}

export function assertShortYearFactorAgrees(yearStart: string, yearEnd: string, declared?: string | number | null): string {
  const months = shortTaxYearMonths(yearStart, yearEnd);
  const implied = impliedShortYearFactor(yearStart, yearEnd);
  if (declared == null || String(declared).trim() === "") return implied;
  const exact = normalizeDecimal(declared, 10);
  const declaredMonths = formatMoney(roundMoney(mulDecimal(exact, "12"), 0), 0);
  if (declaredMonths !== String(months)) {
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

export function remainingAfter(basis: string, deduction: string): string {
  const next = add(basis, neg(deduction));
  return formatMoney(cmp(next, "0") < 0 ? "0" : next, 2);
}
