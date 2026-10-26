/**
 * Recurrence of service agreement visits. A rule repeats daily, weekly on
 * chosen weekdays, monthly on the anchor's day of month or its nth weekday,
 * or yearly, every `interval` units from an anchor date. Occurrences are
 * whole civil dates computed on the calendar grid, so generation is
 * deterministic for any range and never depends on the clock or time zone.
 *
 * Pure: no database or engine imports beyond the civil-date helpers.
 */
import {
  addCalendarDays,
  addMonthsClamped,
  addMonthsStart,
  calendarDaysBetween,
  civilDayIndex,
  daysInCivilMonth,
  isoFromCivilDayIndex,
} from "../platform/civil-date.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { ServiceError } from "./errors.ts";

export const SERVICE_REPEATS = ["daily", "weekly", "monthly", "yearly"] as const;
export type ServiceRepeat = (typeof SERVICE_REPEATS)[number];

export interface ServiceRecurrence {
  readonly repeat: ServiceRepeat;
  /** Every N days, weeks, months or years (1 through 52). */
  readonly interval: number;
  /** Weekly only: weekdays, 0 Sunday through 6 Saturday. Defaults to the anchor's weekday. */
  readonly weekdays?: readonly number[];
  /** Monthly only: the anchor's day of month, or its nth weekday (a fifth weekday falls back to the last). */
  readonly monthlyBy?: "day" | "weekday";
}

/** The most occurrences one generation call produces. */
export const MAX_OCCURRENCES = 1000;

function invalid(message: string): ServiceError {
  return new ServiceError(message, {
    code: "service_invalid_recurrence",
    remedy:
      "Choose how often the visit repeats: daily, weekly on chosen days, monthly or yearly, every 1 to 52 units.",
  });
}

/** Validate and normalize a stored or submitted recurrence rule. */
export function parseRecurrence(value: unknown): ServiceRecurrence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("The recurrence is not valid.");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["repeat", "interval", "weekdays", "monthlyBy"]);
  for (const key of Object.keys(record))
    if (!allowed.has(key)) throw invalid(`The recurrence has an unknown setting "${key}".`);
  const repeat = record.repeat;
  if (typeof repeat !== "string" || !(SERVICE_REPEATS as readonly string[]).includes(repeat))
    throw invalid("Choose daily, weekly, monthly or yearly.");
  const interval = record.interval;
  if (
    typeof interval !== "number" ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > 52
  )
    throw invalid("The repeat interval must be a whole number from 1 to 52.");
  const rule: {
    repeat: ServiceRepeat;
    interval: number;
    weekdays?: number[];
    monthlyBy?: "day" | "weekday";
  } = { repeat: repeat as ServiceRepeat, interval };
  if (record.weekdays !== undefined) {
    if (repeat !== "weekly") throw invalid("Weekdays apply to weekly visits only.");
    if (
      !Array.isArray(record.weekdays) ||
      record.weekdays.length === 0 ||
      record.weekdays.length > 7
    )
      throw invalid("Choose at least one weekday.");
    const days = new Set<number>();
    for (const day of record.weekdays) {
      if (typeof day !== "number" || !Number.isSafeInteger(day) || day < 0 || day > 6)
        throw invalid("Weekdays run from 0 (Sunday) to 6 (Saturday).");
      days.add(day);
    }
    rule.weekdays = [...days].sort((a, b) => a - b);
  }
  if (record.monthlyBy !== undefined) {
    if (repeat !== "monthly") throw invalid("A monthly basis applies to monthly visits only.");
    if (record.monthlyBy !== "day" && record.monthlyBy !== "weekday")
      throw invalid("Repeat monthly on the day of the month or on the weekday.");
    rule.monthlyBy = record.monthlyBy;
  }
  return rule;
}

/** Weekday of a civil date, 0 Sunday through 6 Saturday. */
export function civilWeekday(iso: string): number {
  // 1970-01-01, day index 0, was a Thursday.
  return (((civilDayIndex(iso) + 4) % 7) + 7) % 7;
}

function nthWeekdayOfMonth(monthStart: string, weekday: number, nth: number): string {
  const offset = (weekday - civilWeekday(monthStart) + 7) % 7;
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  const last = daysInCivilMonth(year, month);
  let day = 1 + offset + nth * 7;
  if (day > last) day -= 7;
  return addCalendarDays(monthStart, day - 1);
}

/**
 * Every occurrence of `rule` anchored at `anchor` that falls within
 * [from, through], ascending. Occurrences before the anchor never exist.
 */
export function recurrenceOccurrences(
  rule: ServiceRecurrence,
  anchor: string,
  from: string,
  through: string,
): string[] {
  if (!isIsoCalendarDate(anchor) || !isIsoCalendarDate(from) || !isIsoCalendarDate(through))
    throw invalid("Recurrence dates must be real calendar dates.");
  const start = calendarDaysBetween(anchor, from) > 0 ? from : anchor;
  if (calendarDaysBetween(start, through) < 0) return [];
  const out: string[] = [];
  const push = (date: string): boolean => {
    if (calendarDaysBetween(date, through) < 0) return false;
    if (calendarDaysBetween(start, date) >= 0) {
      out.push(date);
      if (out.length >= MAX_OCCURRENCES) return false;
    }
    return true;
  };
  if (rule.repeat === "daily") {
    // Jump to the first step on or after the window start.
    const skipped = Math.max(0, Math.floor(calendarDaysBetween(anchor, start) / rule.interval));
    for (let step = skipped; ; step += 1) {
      if (!push(addCalendarDays(anchor, step * rule.interval))) break;
    }
    return out;
  }
  if (rule.repeat === "weekly") {
    const weekdays = rule.weekdays?.length ? rule.weekdays : [civilWeekday(anchor)];
    const anchorWeek = addCalendarDays(anchor, -civilWeekday(anchor));
    const weeksToStart = Math.max(0, Math.floor(calendarDaysBetween(anchorWeek, start) / 7));
    let step = Math.floor(weeksToStart / rule.interval);
    for (;;) {
      const weekStart = addCalendarDays(anchorWeek, step * rule.interval * 7);
      if (calendarDaysBetween(weekStart, through) < 0) break;
      let more = true;
      for (const weekday of weekdays) {
        const date = addCalendarDays(weekStart, weekday);
        if (calendarDaysBetween(anchor, date) < 0) continue;
        if (!push(date)) {
          more = false;
          break;
        }
      }
      if (!more) break;
      step += 1;
    }
    return out;
  }
  const months = rule.repeat === "yearly" ? 12 * rule.interval : rule.interval;
  const anchorYear = Number(anchor.slice(0, 4));
  const startYear = Number(start.slice(0, 4));
  const monthsToStart = Math.max(
    0,
    (startYear - anchorYear) * 12 + Number(start.slice(5, 7)) - Number(anchor.slice(5, 7)),
  );
  let step = Math.max(0, Math.floor(monthsToStart / months) - 1);
  const byWeekday = rule.repeat === "monthly" && rule.monthlyBy === "weekday";
  const nth = Math.floor((Number(anchor.slice(8, 10)) - 1) / 7);
  const weekday = civilWeekday(anchor);
  for (;;) {
    const date = byWeekday
      ? nthWeekdayOfMonth(addMonthsStart(anchor, step * months), weekday, nth)
      : addMonthsClamped(anchor, step * months);
    if (!push(date)) break;
    step += 1;
  }
  return out;
}

/** The occurrence dates a sorted set of effective-dated rules produces over [from, through]. */
export function versionedOccurrences(
  versions: readonly {
    readonly id: string;
    readonly effectiveFrom: string;
    readonly recurrence: ServiceRecurrence;
  }[],
  limits: { readonly startsOn: string; readonly endsOn: string | null },
  from: string,
  through: string,
): { versionId: string; occursOn: string }[] {
  const ordered = [...versions].sort((a, b) =>
    calendarDaysBetween(b.effectiveFrom, a.effectiveFrom),
  );
  const out: { versionId: string; occursOn: string }[] = [];
  const windowEnd =
    limits.endsOn && calendarDaysBetween(limits.endsOn, through) > 0 ? limits.endsOn : through;
  for (let index = 0; index < ordered.length; index += 1) {
    const version = ordered[index]!;
    const next = ordered[index + 1];
    const versionStart =
      calendarDaysBetween(version.effectiveFrom, limits.startsOn) > 0
        ? limits.startsOn
        : version.effectiveFrom;
    const versionEnd = next ? addCalendarDays(next.effectiveFrom, -1) : windowEnd;
    const lower = calendarDaysBetween(versionStart, from) > 0 ? from : versionStart;
    const upper = calendarDaysBetween(versionEnd, windowEnd) < 0 ? windowEnd : versionEnd;
    if (calendarDaysBetween(lower, upper) < 0) continue;
    for (const occursOn of recurrenceOccurrences(
      version.recurrence,
      version.effectiveFrom,
      lower,
      upper,
    )) {
      out.push({ versionId: version.id, occursOn });
      if (out.length >= MAX_OCCURRENCES) return out;
    }
  }
  return out;
}

/** The day index after which the last occurrence would fall (exposed for tests and horizons). */
export function horizonDate(today: string, horizonDays: number): string {
  return isoFromCivilDayIndex(civilDayIndex(today) + horizonDays);
}
