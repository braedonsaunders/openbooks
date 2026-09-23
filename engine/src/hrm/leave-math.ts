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

export interface AccrualSegment {
  /** Accrual rule of the policy owning this window. */
  readonly rule: AccrualRule;
  /** Inclusive window start (YYYY-MM-DD). */
  readonly from: string;
  /** Inclusive window end, null = open-ended. */
  readonly to: string | null;
}

/**
 * Hours earned across effective-dated policy segments within one accrual
 * year [yearStart, asOf]. Returns null when any in-window segment is
 * unlimited: an unbounded half-year makes the total unbounded, and pricing
 * it under the successor's rule would invent a number nobody promised.
 *
 * - per_period credits each whole slice of the year's grid at the rate of
 *   the policy covering the slice's FIRST service day, so a mid-year
 *   cadence change earns the old rate for slices begun before the switch
 *   and the new rate after. A slice begun on an uncovered (gap) day earns
 *   nothing, and a mid-period hire still earns nothing for the unworked
 *   part of the slice.
 * - per_year is an annual grant, not a time-apportioned one: it vests in
 *   full to the segment holding asOf and lapses for earlier segments.
 * - none earns zero.
 */
export function accrualEarnedAcrossSegments(
  segments: readonly AccrualSegment[],
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
  const windowed = segments.filter((seg) => {
    parseCivilDate(seg.from);
    if (seg.to !== null) parseCivilDate(seg.to);
    return seg.from <= asOf && (seg.to === null || seg.to >= yearStart);
  });
  if (windowed.some((seg) => seg.rule.kind === "unlimited")) return null;
  // Day-number grid of the accrual year for slice-start vesting below.
  // Built once: every segment of the call shares the year's civil grid.
  const yearEnd = prevDay(addYears(yearStart, 1));
  const yearDates = eachDayOfRange(yearStart, yearEnd);
  const yearDays = yearDates.length;
  const dayIndex = new Map(yearDates.map((day, index) => [day, index]));
  let total = 0n;
  for (const seg of windowed) {
    const rule = seg.rule;
    if (rule.kind === "none" || rule.kind === "unlimited") continue;
    if (rule.kind === "per_year") {
      if (rule.hours == null) {
        throw new LeaveMathError("a per_year accrual rule must carry hours — set hours or use kind none");
      }
      if (seg.from <= asOf && (seg.to === null || seg.to >= asOf)) {
        total += parseHoursToCents(rule.hours);
      }
      continue;
    }
    if (rule.hours == null) {
      throw new LeaveMathError("a per_period accrual rule must carry hours — set hours or use kind none");
    }
    const perYear = rule.periods_per_year;
    if (!Number.isInteger(perYear) || (perYear as number) <= 0) {
      throw new LeaveMathError(
        "a per_period accrual rule must carry periods_per_year (a positive integer) — without it a period cannot be pro-rated",
      );
    }
    const clippedStart = seg.from < yearStart ? yearStart : seg.from;
    const clippedEnd = seg.to === null || seg.to > asOf ? asOf : seg.to;
    if (clippedEnd < clippedStart || clippedStart > yearEnd) continue;
    // Slice k (1-based) of this rule's grid starts on day
    // floor(((k-1) * yearDays) / ppy) + 1 and only vests once complete,
    // so k runs over completed slices whose start day the window holds.
    // Exact integer bounds, no iteration over the slice count.
    const lo = (dayIndex.get(clippedStart) ?? 0) + 1;
    const hi = clippedEnd >= yearEnd ? yearDays : (dayIndex.get(clippedEnd) ?? yearDays - 1) + 1;
    const completed = wholePeriodsElapsed(yearStart, asOf, perYear as number);
    // Closed-form bounds with exact day-number verification: the float
    // division below can sit 1 ulp off an integer boundary, so each bound
    // is walked to the true edge (at most a step — start days are
    // monotone in k, and the walk always terminates).
    let first = Math.floor(((lo - 1) * (perYear as number)) / yearDays) + 1;
    while (sliceStartDay(first, yearDays, perYear as number) < lo) first += 1;
    while (first > 1 && sliceStartDay(first - 1, yearDays, perYear as number) >= lo) first -= 1;
    let last = Math.min(completed, Math.floor((hi * (perYear as number)) / yearDays) + 1);
    while (last >= first && sliceStartDay(last, yearDays, perYear as number) > hi) last -= 1;
    while (last + 1 <= completed && sliceStartDay(last + 1, yearDays, perYear as number) <= hi) last += 1;
    const count = Math.max(0, last - first + 1);
    total += parseHoursToCents(rule.hours) * BigInt(count);
  }
  return formatCents(total);
}

/** 1-based day number of the year's grid on which slice k starts. */
function sliceStartDay(k: number, yearDays: number, periodsPerYear: number): number {
  return Math.floor(((k - 1) * yearDays) / periodsPerYear) + 1;
}

export interface ReignSegment {
  /** Accrual rule of the policy governing this reign. */
  readonly rule: AccrualRule;
  /** Inclusive reign window (YYYY-MM-DD). */
  readonly from: string;
  readonly to: string;
}

/**
 * Per-day applicable-policy reigns over [from, to]: maximal runs of days
 * governed by one policy under selectPolicy's precedence. A department
 * policy REPLACES the org-wide rule for its workers — it never stacks —
 * so accrual walks these reigns, never the raw type-wide segment list
 * (which would price org-wide unlimited into a capped worker's balance
 * and grant org + department twice). Gap days carry no reign and earn
 * nothing. Pure and day-walked (at most a civil year plus the tail).
 */
export function selectReigns<T extends PolicyCandidate & { rule: AccrualRule }>(
  policies: readonly T[],
  scope: { employerSubsidiaryId: string | null; departmentId: string | null },
  from: string,
  to: string,
): ReignSegment[] {
  const reigns: ReignSegment[] = [];
  let openId: string | null = null;
  let openRule: AccrualRule | null = null;
  let openFrom = from;
  for (const day of eachDayOfRange(from, to)) {
    const pick = selectPolicy(policies, scope, day);
    if (pick?.id !== openId) {
      if (openId !== null && openRule !== null) {
        reigns.push({ rule: openRule, from: openFrom, to: prevDay(day) });
      }
      openId = pick?.id ?? null;
      openRule = pick?.rule ?? null;
      openFrom = day;
    }
  }
  if (openId !== null && openRule !== null) {
    reigns.push({ rule: openRule, from: openFrom, to });
  }
  return reigns;
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
  /** Inclusive window end, null/undefined = open-ended. Absent = no end filter. */
  readonly effectiveTo?: string | null;
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
    if (policy.effectiveTo != null && policy.effectiveTo < onDate) continue;
    const subMatch = policy.employerSubsidiaryId === null || policy.employerSubsidiaryId === scope.employerSubsidiaryId;
    const depMatch = policy.departmentId === null || policy.departmentId === scope.departmentId;
    if (!subMatch || !depMatch) continue;
    // A null pin is a wildcard, never a match: specificity counts only pins.
    let score = 0;
    if (policy.employerSubsidiaryId !== null) score += 2;
    if (policy.departmentId !== null) score += 1;
    scored.push({ policy, score });
  }
  // Total order: specificity, then latest start, then id. The old comparator
  // returned 1 on equal effective_from, so an exact tie resolved by sort
  // internals rather than by data — two same-scope policies in force on one
  // day picked arbitrarily.
  scored.sort((a, b) =>
    b.score - a.score ||
    (a.policy.effectiveFrom < b.policy.effectiveFrom ? 1 : a.policy.effectiveFrom > b.policy.effectiveFrom ? -1 : 0) ||
    (a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0),
  );
  return scored[0]?.policy ?? null;
}
