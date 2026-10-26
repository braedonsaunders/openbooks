import { addCalendarDays, addMonthsClamped, calendarDaysBetween } from "../platform/civil-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { parseCivilDate } from "./temporal.ts";

/**
 * Pure leave time-balance and overlap math. Every function here is tested without a database,
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
  const canonical = canonicalDecimal(value, 2);
  if (canonical === null) {
    throw new LeaveMathError(
      `invalid hours ${JSON.stringify(value)}: use an exact decimal with at most 2 fraction digits`,
    );
  }
  const [whole, fraction = ""] = canonical.replace(/^-/, "").split(".");
  const magnitude = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return canonical.startsWith("-") ? -magnitude : magnitude;
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

/** Every civil day in [start, end], inclusive, as YYYY-MM-DD text. */
export function eachDayOfRange(start: string, end: string): string[] {
  parseCivilDate(start);
  parseCivilDate(end);
  if (end < start) {
    throw new LeaveMathError(`effective end ${end} must not be before start ${start}`);
  }
  // Civil-day walk on explicit Y/M/D integer arithmetic: no Date objects,
  // no time zones. Lexicographic comparison is exact on zero-padded ISO.
  const days: string[] = [];
  let cursor = start;
  for (;;) {
    days.push(cursor);
    if (cursor === end) break;
    cursor = addCalendarDays(cursor, 1);
    if (days.length > 3700) {
      throw new LeaveMathError(
        `leave range ${start} to ${end} exceeds ten years — file separate requests per accrual year`,
      );
    }
  }
  return days;
}

/** Inclusive day-range overlap: shared boundary days collide. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  for (const bound of [aStart, aEnd, bStart, bEnd]) parseCivilDate(bound);
  return aStart <= bEnd && bStart <= aEnd;
}

export interface AccrualTier {
  /** Completed service years from which this tier's hours apply. */
  readonly after_years: number;
  readonly hours: string;
}

export interface AccrualRule {
  readonly kind: "none" | "per_period" | "per_year" | "unlimited";
  readonly hours?: string;
  readonly periods_per_year?: number;
  /**
   * Service-based tiers, ascending by after_years. Null (or absent) means
   * the base hours apply at every tenure. Below the first tier the base
   * hours apply; an unknown service start also accrues base hours, and the
   * balance read flags that so an operator can fix the start date.
   */
  readonly tiers?: AccrualTier[] | null;
}

export interface CarryoverRule {
  readonly kind: "none" | "carry_all" | "carry_up_to";
  readonly hours?: string | null;
  readonly expires_after_days?: number | null;
}

/**
 * Tenure context for service-based tiers: the worker's service start
 * (YYYY-MM-DD) or null when it is unknown. Unknown tenure accrues base
 * hours — the balance read flags that separately, never silently.
 */
export interface AccrualTenure {
  readonly serviceStart: string | null;
}

/**
 * Shape-checked tiers of a rule: null/undefined/absent means no tiers.
 * Malformed tiers fail closed (throw) rather than accruing zero — a rule
 * that still arrives malformed must refuse at the balance read, never
 * price leave at a rate nobody declared.
 */
export function requireRuleTiers(rule: AccrualRule): AccrualTier[] | null {
  const tiers = rule.tiers;
  if (tiers === undefined || tiers === null) return null;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new LeaveMathError(
      "accrual_rule.tiers is a non-empty list of {after_years, hours} — record the tiers or omit them",
    );
  }
  let previous = -1;
  for (const tier of tiers) {
    if (typeof tier !== "object" || tier === null) {
      throw new LeaveMathError(
        "accrual_rule.tiers entries carry after_years and hours — record each tier",
      );
    }
    const years = (tier as AccrualTier).after_years;
    const hours = (tier as AccrualTier).hours;
    if (!Number.isInteger(years) || (years as number) < 1) {
      throw new LeaveMathError(
        "accrual_rule.tiers after_years is a positive whole number of completed service years — record each tier's threshold",
      );
    }
    if (typeof hours !== "string") {
      throw new LeaveMathError(
        "accrual_rule.tiers hours is an exact decimal — record each tier's hours",
      );
    }
    let cents: HourCents;
    try {
      cents = parseHoursToCents(hours);
    } catch {
      throw new LeaveMathError(
        "accrual_rule.tiers hours is an exact decimal with at most 2 fraction digits — record each tier's hours",
      );
    }
    if (cents <= 0n) {
      throw new LeaveMathError(
        "accrual_rule.tiers hours must be greater than zero — record each tier's hours",
      );
    }
    if ((years as number) <= previous) {
      throw new LeaveMathError(
        "accrual_rule.tiers after_years ascends strictly — order the tiers by completed service years",
      );
    }
    previous = years as number;
  }
  return tiers as AccrualTier[];
}

/** Completed service years on a date: whole anniversaries of serviceStart passed. */
export function completedServiceYears(serviceStart: string, onDate: string): number {
  parseCivilDate(serviceStart);
  parseCivilDate(onDate);
  // Lexicographic month-day comparison is exact on zero-padded ISO: the
  // anniversary counts once the month-day has been reached that year.
  let years = Number(onDate.slice(0, 4)) - Number(serviceStart.slice(0, 4));
  if (onDate.slice(5) < serviceStart.slice(5)) years -= 1;
  return Math.max(0, years);
}

/**
 * Hours in force on a date under a per_year/per_period rule: the highest
 * tier whose after_years the completed service covers, else the base
 * hours. Unknown tenure accrues base hours — flagged by the balance read,
 * never re-rated retroactively once the start date is fixed.
 */
export function tieredHoursForDate(
  rule: AccrualRule,
  baseHours: string,
  serviceStart: string | null,
  onDate: string,
): string {
  const tiers = requireRuleTiers(rule);
  if (tiers === null) return formatCents(parseHoursToCents(baseHours));
  if (serviceStart === null) return formatCents(parseHoursToCents(baseHours));
  const completed = completedServiceYears(serviceStart, onDate);
  let hours = baseHours;
  for (const tier of tiers) {
    if (tier.after_years <= completed) hours = tier.hours;
    else break;
  }
  return formatCents(parseHoursToCents(hours));
}

/**
 * Hours earned under a rule between yearStart and asOf (both inclusive).
 * Returns null for unlimited (unbounded, never a number). per_period
 * pro-rates by whole elapsed periods: periods_per_year slices the accrual
 * year evenly and only completed slices count, so a mid-period hire never
 * earns the unworked part of the slice.
 *
 * Service tiers resolve per accrual event, never once for the whole
 * range: a per_period slice accrues at the tier in force on its vesting
 * (completion) date and a per_year grant at the tier in force on asOf, so
 * the balance day can never re-rate earlier events retroactively and the
 * entitlement reproduces for any past as-of date.
 */
export function accrualEarned(
  rule: AccrualRule,
  yearStart: string,
  asOf: string,
  tenure?: AccrualTenure,
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
        throw new LeaveMathError(
          "a per_year accrual rule must carry hours — set hours or use kind none",
        );
      }
      return tieredHoursForDate(rule, rule.hours, tenure?.serviceStart ?? null, asOf);
    }
    case "per_period": {
      if (rule.hours == null) {
        throw new LeaveMathError(
          "a per_period accrual rule must carry hours — set hours or use kind none",
        );
      }
      const perYear = rule.periods_per_year;
      if (!Number.isInteger(perYear) || (perYear as number) <= 0) {
        throw new LeaveMathError(
          "a per_period accrual rule must carry periods_per_year (a positive integer) — without it a period cannot be pro-rated",
        );
      }
      const elapsed = wholePeriodsElapsed(yearStart, asOf, perYear as number);
      const tiers = requireRuleTiers(rule);
      if (tiers === null) {
        return formatCents(parseHoursToCents(rule.hours) * BigInt(elapsed));
      }
      // Tiered cadence: each completed slice accrues at the tier in force
      // on its vesting date (its last day), so an anniversary mid-year
      // lifts later slices without re-rating earlier ones.
      const yearEnd = addCalendarDays(addMonthsClamped(yearStart, 12), -1);
      const yearDates = eachDayOfRange(yearStart, yearEnd);
      let total = 0n;
      for (let slice = 1; slice <= elapsed; slice += 1) {
        const endDay = sliceEndDay(slice, yearDates.length, perYear as number);
        const vesting = yearDates[endDay - 1]!;
        total += parseHoursToCents(
          tieredHoursForDate(rule, rule.hours, tenure?.serviceStart ?? null, vesting),
        );
      }
      return formatCents(total);
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
  tenure?: AccrualTenure,
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
  const yearEnd = addCalendarDays(addMonthsClamped(yearStart, 12), -1);
  const yearDates = eachDayOfRange(yearStart, yearEnd);
  const yearDays = yearDates.length;
  const dayIndex = new Map(yearDates.map((day, index) => [day, index]));
  let total = 0n;
  for (const seg of windowed) {
    const rule = seg.rule;
    if (rule.kind === "none" || rule.kind === "unlimited") continue;
    if (rule.kind === "per_year") {
      if (rule.hours == null) {
        throw new LeaveMathError(
          "a per_year accrual rule must carry hours — set hours or use kind none",
        );
      }
      if (seg.from <= asOf && (seg.to === null || seg.to >= asOf)) {
        total += parseHoursToCents(
          tieredHoursForDate(rule, rule.hours, tenure?.serviceStart ?? null, asOf),
        );
      }
      continue;
    }
    if (rule.hours == null) {
      throw new LeaveMathError(
        "a per_period accrual rule must carry hours — set hours or use kind none",
      );
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
    const tiered = requireRuleTiers(rule) !== null;
    if (tiered) {
      // Tiered cadence prices each vested slice at the tier in force on
      // its vesting day (bounded: at most periods_per_year slices), so a
      // mid-window anniversary lifts later slices without re-rating
      // earlier ones. The untiered closed form below is untouched.
      const serviceStart = tenure?.serviceStart ?? null;
      const lo = (dayIndex.get(clippedStart) ?? 0) + 1;
      const hi = clippedEnd >= yearEnd ? yearDays : (dayIndex.get(clippedEnd) ?? yearDays - 1) + 1;
      const completed = wholePeriodsElapsed(yearStart, asOf, perYear as number);
      let first = Math.floor(((lo - 1) * (perYear as number)) / yearDays) + 1;
      while (sliceStartDay(first, yearDays, perYear as number) < lo) first += 1;
      while (first > 1 && sliceStartDay(first - 1, yearDays, perYear as number) >= lo) first -= 1;
      let last = Math.min(completed, Math.floor((hi * (perYear as number)) / yearDays) + 1);
      while (last >= first && sliceStartDay(last, yearDays, perYear as number) > hi) last -= 1;
      while (last + 1 <= completed && sliceStartDay(last + 1, yearDays, perYear as number) <= hi)
        last += 1;
      for (let slice = Math.max(first, 1); slice <= last; slice += 1) {
        const endDay = sliceEndDay(slice, yearDays, perYear as number);
        const vesting = yearDates[endDay - 1]!;
        total += parseHoursToCents(
          tieredHoursForDate(rule, rule.hours as string, serviceStart, vesting),
        );
      }
      continue;
    }
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
    while (last + 1 <= completed && sliceStartDay(last + 1, yearDays, perYear as number) <= hi)
      last += 1;
    const count = Math.max(0, last - first + 1);
    total += parseHoursToCents(rule.hours) * BigInt(count);
  }
  return formatCents(total);
}

/**
 * An effective-dated policy window with its targeting pins, for the
 * same-specificity overlap check. Null pin lists are wildcards.
 */
export interface TargetedPolicyWindow {
  readonly id: string;
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
  readonly employmentIds: readonly string[] | null;
  readonly classificationIds: readonly string[] | null;
  readonly effectiveFrom: string;
  /** Inclusive window end, null = open-ended. */
  readonly effectiveTo: string | null;
}

/**
 * The pinned set of a targeting dimension, or null for wildcard. Empty
 * and absent lists both read as wildcard — writes refuse empty lists, so
 * this only ever normalizes legacy rows — matching the storage guard,
 * which exempts empty arrays from the wildcard-only exclusion the same
 * way it exempts absent keys.
 */
export function pinnedIds(ids: readonly string[] | null | undefined): readonly string[] | null {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return ids;
}

/**
 * Specificity score of a pin pattern: employment pin 8, classification
 * pin 4, subsidiary pin 2, department pin 1 — the same weights selectPolicy
 * resolves by. Binary weights make equal scores mean identical pin
 * patterns: two policies in one class resolve by start date, so an
 * overlapping window with intersecting targets is genuinely ambiguous.
 */
export function targetingSpecificity(
  window: Omit<TargetedPolicyWindow, "id" | "effectiveFrom" | "effectiveTo">,
): number {
  let score = 0;
  if (window.employerSubsidiaryId !== null) score += 2;
  if (window.departmentId !== null) score += 1;
  if (pinnedIds(window.employmentIds) !== null) score += 8;
  if (pinnedIds(window.classificationIds) !== null) score += 4;
  return score;
}

function targetSetsIntersect(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = pinnedIds(a);
  const right = pinnedIds(b);
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left.some((id) => right.includes(id));
}

/**
 * Same-specificity overlap conflict, if any: the first active window that
 * shares the candidate's specificity class (identical pin pattern),
 * overlaps its window, and has intersecting employment AND
 * classification sets (wildcards intersect only wildcards — a pinned set
 * never collides with an unpinned one, which specificity resolves).
 * Pure so every writer (engine create, Setup create/update) refuses the
 * same conflict with the same policy named.
 */
export function findSameSpecificityConflict(
  candidate: Omit<TargetedPolicyWindow, "id">,
  actives: readonly TargetedPolicyWindow[],
): TargetedPolicyWindow | null {
  const candidateEnd = candidate.effectiveTo ?? "9999-12-31";
  const classScore = targetingSpecificity(candidate);
  for (const active of actives) {
    if (targetingSpecificity(active) !== classScore) continue;
    if (
      !rangesOverlap(
        candidate.effectiveFrom,
        candidateEnd,
        active.effectiveFrom,
        active.effectiveTo ?? "9999-12-31",
      )
    ) {
      continue;
    }
    if (!targetSetsIntersect(candidate.employmentIds, active.employmentIds)) continue;
    if (!targetSetsIntersect(candidate.classificationIds, active.classificationIds)) continue;
    return active;
  }
  return null;
}

/** 1-based day number of the year's grid on which slice k starts. */
function sliceStartDay(k: number, yearDays: number, periodsPerYear: number): number {
  return Math.floor(((k - 1) * yearDays) / periodsPerYear) + 1;
}

/** 1-based day number of the year's grid on which slice k ends (its vesting day). */
function sliceEndDay(k: number, yearDays: number, periodsPerYear: number): number {
  if (k >= periodsPerYear) return yearDays;
  return sliceStartDay(k + 1, yearDays, periodsPerYear) - 1;
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
 *
 * The scope may be a per-day resolver so classification targeting follows
 * the classifications the worker actually holds each day: a classification
 * held for only part of the period governs only that part.
 */
export function selectReigns<T extends PolicyCandidate & { rule: AccrualRule }>(
  policies: readonly T[],
  scope: PolicyMatchScope | ((day: string) => PolicyMatchScope),
  from: string,
  to: string,
): ReignSegment[] {
  const reigns: ReignSegment[] = [];
  let openId: string | null = null;
  let openRule: AccrualRule | null = null;
  let openFrom = from;
  for (const day of eachDayOfRange(from, to)) {
    const pick = selectPolicy(policies, typeof scope === "function" ? scope(day) : scope, day);
    if (pick?.id !== openId) {
      if (openId !== null && openRule !== null) {
        reigns.push({ rule: openRule, from: openFrom, to: addCalendarDays(day, -1) });
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
  const yearEndExclusive = addMonthsClamped(yearStart, 12);
  const cappedExclusive = asOf >= yearEndExclusive ? yearEndExclusive : addCalendarDays(asOf, 1);
  const elapsedDays =
    cappedExclusive <= yearStart
      ? 0
      : eachDayOfRange(yearStart, addCalendarDays(cappedExclusive, -1)).length;
  const yearDays = eachDayOfRange(yearStart, addCalendarDays(yearEndExclusive, -1)).length;
  // Slice length in days, fractional slices never credit: floor only.
  const elapsed = Math.floor((elapsedDays * periodsPerYear) / yearDays);
  return Math.min(periodsPerYear, Math.max(0, elapsed));
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
    if (asOf < yearStart) {
      throw new LeaveMathError(`as-of ${asOf} is before the carryover year start ${yearStart}`);
    }
    const daysIn = calendarDaysBetween(yearStart, asOf);
    if (daysIn > rule.expires_after_days) return "0";
  }
  if (rule.kind === "carry_all") return formatCents(unused);
  // carry_up_to
  if (rule.hours == null) {
    throw new LeaveMathError(
      "a carry_up_to rule must carry hours — set the cap or use kind carry_all",
    );
  }
  const cap = parseHoursToCents(rule.hours);
  return formatCents(unused < cap ? unused : cap);
}

/** Split total hours across days in exact cents: first days take the remainder. */
export function splitHoursAcrossDays(totalHours: string, dayCount: number): string[] {
  if (!Number.isInteger(dayCount) || dayCount <= 0) {
    throw new LeaveMathError(
      "a day split needs a positive whole day count — split across the days of the range",
    );
  }
  const total = parseHoursToCents(totalHours);
  const n = BigInt(dayCount);
  const base = total / n;
  const remainder = total % n;
  return Array.from({ length: dayCount }, (_, index) =>
    formatCents(base + (BigInt(index) < remainder ? 1n : 0n)),
  );
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
    parseHoursToCents(args.earned) +
      parseHoursToCents(args.carried) -
      parseHoursToCents(args.taken),
  );
}

export interface PolicyCandidate {
  readonly id: string;
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
  /**
   * Targeted employments (null/undefined = every employment) and
   * classifications (null/undefined = every classification). Absent reads
   * as wildcard, so candidates built before targeting existed keep
   * matching exactly as before.
   */
  readonly employmentIds?: readonly string[] | null;
  readonly classificationIds?: readonly string[] | null;
  readonly effectiveFrom: string;
  /** Inclusive window end, null/undefined = open-ended. Absent = no end filter. */
  readonly effectiveTo?: string | null;
}

/**
 * The worker side of policy matching. employmentId and
 * classificationIds are optional so historic call sites keep compiling;
 * a policy that pins employments or classifications never matches a
 * scope that omits that dimension — targeting fails closed, never open.
 */
export interface PolicyMatchScope {
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
  readonly employmentId?: string | null;
  readonly classificationIds?: readonly string[] | null;
}

/**
 * Most-specific applicable policy. Specificity weights: an employment pin
 * counts 8, a classification pin 4, a subsidiary pin 2, a department pin
 * 1 — so a directly targeted worker always beats a broader rule, and a
 * department rule still beats org-wide. A pinned dimension matches only
 * its listed values: an employment matches when listed, a classification
 * dimension matches when any held classification is listed. Ties break by
 * latest effective_from, then id. Pure so the precedence is unit-tested,
 * never re-derived per call site.
 */
export function selectPolicy<T extends PolicyCandidate>(
  policies: readonly T[],
  scope: PolicyMatchScope,
  onDate: string,
): T | null {
  const scored: { policy: T; score: number }[] = [];
  for (const policy of policies) {
    if (policy.effectiveFrom > onDate) continue;
    if (policy.effectiveTo != null && policy.effectiveTo < onDate) continue;
    const subMatch =
      policy.employerSubsidiaryId === null ||
      policy.employerSubsidiaryId === scope.employerSubsidiaryId;
    const depMatch = policy.departmentId === null || policy.departmentId === scope.departmentId;
    // Empty lists read as wildcard (pinnedIds), exactly like absent keys.
    const empPins = pinnedIds(policy.employmentIds);
    const clsPins = pinnedIds(policy.classificationIds);
    const empMatch =
      empPins === null || (scope.employmentId != null && empPins.includes(scope.employmentId));
    const clsMatch =
      clsPins === null ||
      (scope.classificationIds != null &&
        clsPins.some((pinned) => scope.classificationIds!.includes(pinned)));
    if (!subMatch || !depMatch || !empMatch || !clsMatch) continue;
    // A null pin is a wildcard, never a match: specificity counts only pins.
    let score = 0;
    if (policy.employerSubsidiaryId !== null) score += 2;
    if (policy.departmentId !== null) score += 1;
    if (empPins !== null) score += 8;
    if (clsPins !== null) score += 4;
    scored.push({ policy, score });
  }
  // Total order: specificity, then latest start, then id. The old comparator
  // returned 1 on equal effective_from, so an exact tie resolved by sort
  // internals rather than by data — two same-scope policies in force on one
  // day picked arbitrarily.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.policy.effectiveFrom < b.policy.effectiveFrom
        ? 1
        : a.policy.effectiveFrom > b.policy.effectiveFrom
          ? -1
          : 0) ||
      (a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0),
  );
  return scored[0]?.policy ?? null;
}
