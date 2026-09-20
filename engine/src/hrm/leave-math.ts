import { parseCivilDate } from "./temporal.ts";

/**
 * Pure leave time-balance and overlap math (HR-5). Zero imports beyond the
 * civil-date parser: every function here is unit-tested without a database,
 * and no test doubles it (a pure function has nothing to isolate — mock the
 * database, never this).
 *
 * Hours cross as decimal STRINGS (numeric(9,2) storage) and all arithmetic
 * is exact bigint hundredths. Floating point never touches a leave amount:
 * 0.1 + 0.2 is 0.30000000000000004 in doubles, and a balance that reads
 * 7.30 while the ledger of days sums 7.29 is a payroll dispute.
 */

/** Exact hundredths of an hour. */
export type HourCents = bigint;

export class LeaveMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveMathError";
  }
}

/** Parse an exact decimal hour string (up to 2 fraction digits) to cents. */
export function parseHoursToCents(value: string): HourCents {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new LeaveMathError(
      `invalid hours ${JSON.stringify(value)}: use an exact decimal with at most 2 fraction digits`,
    );
  }
  const sign = match[1] ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const frac = BigInt((match[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100n + frac);
}

/** Format cents back to a minimal exact decimal string. */
export function formatCents(cents: HourCents): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  if (frac === 0n) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(2, "0").replace(/0$/, "");
  return `${sign}${whole}.${fracStr}`;
}

/** Exact decimal comparison: -1, 0, 1. */
export function cmpHours(a: string, b: string): number {
  const diff = parseHoursToCents(a) - parseHoursToCents(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function addHours(a: string, b: string): string {
  return formatCents(parseHoursToCents(a) + parseHoursToCents(b));
}

export function subHours(a: string, b: string): string {
  return formatCents(parseHoursToCents(a) - parseHoursToCents(b));
}

interface CivilParts {
  year: number;
  month: number;
  day: number;
}

function splitParts(date: string): CivilParts {
  parseCivilDate(date);
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function formatParts(parts: CivilParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function nextDay(date: string): string {
  const parts = splitParts(date);
  if (parts.day < daysInMonth(parts.year, parts.month)) return formatParts({ ...parts, day: parts.day + 1 });
  if (parts.month < 12) return formatParts({ year: parts.year, month: parts.month + 1, day: 1 });
  return formatParts({ year: parts.year + 1, month: 1, day: 1 });
}

/** Every civil day in [start, end], inclusive, as YYYY-MM-DD text. */
export function eachDayOfRange(start: string, end: string): string[] {
  parseCivilDate(start);
  parseCivilDate(end);
  if (end < start) {
    throw new LeaveMathError(
      `effective end ${end} must not be before start ${start}`,
    );
  }
  // Civil-day walk on explicit Y/M/D integer arithmetic: no Date objects,
  // no time zones. Lexicographic comparison is exact on zero-padded ISO.
  const days: string[] = [];
  let cursor = start;
  for (;;) {
    days.push(cursor);
    if (cursor === end) break;
    cursor = nextDay(cursor);
    if (days.length > 3700) {
      throw new LeaveMathError(
        `leave range ${start} to ${end} exceeds ten years — file separate requests per accrual year`,
      );
    }
  }
  return days;
}

/** Inclusive day-range overlap: shared boundary days collide. */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  for (const bound of [aStart, aEnd, bStart, bEnd]) parseCivilDate(bound);
  return aStart <= bEnd && bStart <= aEnd;
}

export interface AccrualRule {
  readonly kind: "none" | "per_period" | "per_year" | "unlimited";
  readonly hours?: string;
  readonly periods_per_year?: number;
}

export interface CarryoverRule {
  readonly kind: "none" | "carry_all" | "carry_up_to";
  readonly hours?: string | null;
  readonly expires_after_days?: number | null;
}

/**
 * Hours earned under a rule between yearStart and asOf (both inclusive).
 * Returns null for unlimited (unbounded, never a number). per_period
 * pro-rates by whole elapsed periods: periods_per_year slices the accrual
 * year evenly and only completed slices count, so a mid-period hire never
 * earns the unworked part of the slice.
 */
export function accrualEarned(
  rule: AccrualRule,
  yearStart: string,
  asOf: string,
): string | null {
  parseCivilDate(yearStart);
  parseCivilDate(asOf);
  if (asOf < yearStart) {
    throw new LeaveMathError(
      `as-of ${asOf} precedes accrual year start ${yearStart} — resolve the balance in the year the date belongs to`,
    );
  }
  switch (rule.kind) {
    case "none":
      return "0";
    case "unlimited":
      return null;
    case "per_year": {
      if (rule.hours == null) {
        throw new LeaveMathError("a per_year accrual rule must carry hours — set hours or use kind none");
      }
      return formatCents(parseHoursToCents(rule.hours));
    }
    case "per_period": {
      if (rule.hours == null) {
        throw new LeaveMathError("a per_period accrual rule must carry hours — set hours or use kind none");
      }
      const perYear = rule.periods_per_year;
      if (!Number.isInteger(perYear) || (perYear as number) <= 0) {
        throw new LeaveMathError(
          "a per_period accrual rule must carry periods_per_year (a positive integer) — without it a period cannot be pro-rated",
        );
      }
      const elapsed = wholePeriodsElapsed(yearStart, asOf, perYear as number);
      return formatCents(parseHoursToCents(rule.hours) * BigInt(elapsed));
    }
  }
}

function prevDay(date: string): string {
  const parts = splitParts(date);
  if (parts.day > 1) return formatParts({ ...parts, day: parts.day - 1 });
  if (parts.month > 1) {
    const month = parts.month - 1;
    return formatParts({ year: parts.year, month, day: daysInMonth(parts.year, month) });
  }
  return formatParts({ year: parts.year - 1, month: 12, day: 31 });
}

/** Whole accrual slices completed in [yearStart, asOf]: 0..periodsPerYear. */
export function wholePeriodsElapsed(
  yearStart: string,
  asOf: string,
  periodsPerYear: number,
): number {
  parseCivilDate(yearStart);
  parseCivilDate(asOf);
  // Exclusive-end day counts: the accrual year is [yearStart, next anniversary),
  // elapsed is [yearStart, day after asOf). Inclusive double-counting made a
  // 365-day year read 366 and stole the year's last slice.
  const yearEndExclusive = addYears(yearStart, 1);
  const cappedExclusive = asOf >= yearEndExclusive ? yearEndExclusive : nextDay(asOf);
  const elapsedDays = cappedExclusive <= yearStart ? 0 : eachDayOfRange(yearStart, prevDay(cappedExclusive)).length;
  const yearDays = eachDayOfRange(yearStart, prevDay(yearEndExclusive)).length;
  // Slice length in days, fractional slices never credit: floor only.
  const elapsed = Math.floor((elapsedDays * periodsPerYear) / yearDays);
  return Math.min(periodsPerYear, Math.max(0, elapsed));
}

function daysBetweenInclusive(start: string, end: string): number {
  return eachDayOfRange(start, end).length;
}

function addYears(date: string, years: number): string {
  const y = Number(date.slice(0, 4)) + years;
  const rest = date.slice(4);
  const candidate = `${String(y).padStart(4, "0")}${rest}`;
  // Feb 29 lands on Feb 28 outside leap years — the accrual year still ends.
  try {
    parseCivilDate(candidate);
    return candidate;
  } catch {
    return `${String(y).padStart(4, "0")}-02-28`;
  }
}

/**
 * Prior-year unused hours surviving into the new year. Expiry is
 * day-counted from the new year's start; an expired carryover is zero,
 * never negative. Returns exact decimal text.
 */
export function carryoverApplied(
  rule: CarryoverRule,
  priorUnused: string,
  yearStart: string,
  asOf: string,
): string {
  parseCivilDate(yearStart);
  parseCivilDate(asOf);
  const unused = parseHoursToCents(priorUnused);
  if (unused <= 0n) return "0";
  if (rule.kind === "none") return "0";
  if (rule.expires_after_days != null) {
    const daysIn = daysBetweenInclusive(yearStart, asOf) - 1;
    if (daysIn > rule.expires_after_days) return "0";
  }
  if (rule.kind === "carry_all") return formatCents(unused);
  // carry_up_to
  if (rule.hours == null) {
    throw new LeaveMathError("a carry_up_to rule must carry hours — set the cap or use kind carry_all");
  }
  const cap = parseHoursToCents(rule.hours);
  return formatCents(unused < cap ? unused : cap);
}

/** Split total hours across days in exact cents: first days take the remainder. */
export function splitHoursAcrossDays(totalHours: string, dayCount: number): string[] {
  if (!Number.isInteger(dayCount) || dayCount <= 0) {
    throw new LeaveMathError("a day split needs a positive whole day count — split across the days of the range");
  }
  const total = parseHoursToCents(totalHours);
  const n = BigInt(dayCount);
  const base = total / n;
  const remainder = total % n;
  return Array.from({ length: dayCount }, (_, index) => formatCents(base + (BigInt(index) < remainder ? 1n : 0n)));
}

/**
 * Time balance: earned + carried − taken, as exact decimal text, or null
 * for unlimited (unbounded — never compare it against a number).
 */
export function timeBalance(args: {
  earned: string | null;
  carried: string;
  taken: string;
}): string | null {
  if (args.earned === null) return null;
  return formatCents(
    parseHoursToCents(args.earned) + parseHoursToCents(args.carried) - parseHoursToCents(args.taken),
  );
}

export interface PolicyCandidate {
  readonly id: string;
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
  readonly effectiveFrom: string;
}

/**
 * Most-specific applicable policy: exact (subsidiary + department) beats
 * subsidiary-only and department-only, which beat org-wide; ties break by
 * latest effective_from. Pure so the precedence is unit-tested, never
 * re-derived per call site.
 */
export function selectPolicy<T extends PolicyCandidate>(
  policies: readonly T[],
  scope: { employerSubsidiaryId: string | null; departmentId: string | null },
  onDate: string,
): T | null {
  const scored: { policy: T; score: number }[] = [];
  for (const policy of policies) {
    if (policy.effectiveFrom > onDate) continue;
    const subMatch = policy.employerSubsidiaryId === null || policy.employerSubsidiaryId === scope.employerSubsidiaryId;
    const depMatch = policy.departmentId === null || policy.departmentId === scope.departmentId;
    if (!subMatch || !depMatch) continue;
    // A null pin is a wildcard, never a match: specificity counts only pins.
    let score = 0;
    if (policy.employerSubsidiaryId !== null) score += 2;
    if (policy.departmentId !== null) score += 1;
    scored.push({ policy, score });
  }
  scored.sort((a, b) =>
    b.score - a.score || (b.policy.effectiveFrom < a.policy.effectiveFrom ? -1 : 1),
  );
  return scored[0]?.policy ?? null;
}
