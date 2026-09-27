import { isIsoCalendarDate } from "./iso-date.ts";
export { isIsoCalendarDate } from "./iso-date.ts";

// ---------------------------------------------------------------------------
// Civil-date arithmetic: years 0001-9999 without the 1900 remap
// ---------------------------------------------------------------------------
//
// `Date.UTC(year, ...)` and `new Date(year, ...)` map years 0-99 onto
// 1900-1999, so any civil-date math built on them silently relocates dates in
// years 0001-0099 by eighteen centuries (a 0099-12-25..0100-01-07 window reads
// as a negative ~694,000-day span, and a mid-period assignment prorates to
// zero). These primitives are the ONE civil-date arithmetic in the repo:
// construct through utcDateFromParts (the `new Date(0)` + setUTCFullYear
// idiom, which keeps the literal year) or parse through parseIsoDate
// (ISO-string parsing is exact for years 0001-9999), step through
// addCalendarDays / addMonthsClamped / addMonthsStart, and difference through
// calendarDaysBetween / inclusiveCalendarDays.
// scripts/check-civil-date-arithmetic.mjs refuses Date.UTC / multi-arg
// new Date with a non-literal year anywhere else, so the next site cannot
// regress silently.
//
// This module imports nothing that touches the database, so pure leaves and
// client components import it directly; business-date.ts re-exports it for
// server code that also needs the org's business day.


/** Parse YYYY-MM-DD as a UTC calendar date — no local-timezone shift. */
export function parseIsoDate(iso: string): Date {
  if (!isIsoCalendarDate(iso)) {
    throw new RangeError("business date must be a valid YYYY-MM-DD calendar date in years 0001 through 9999");
  }
  return new Date(`${iso}T00:00:00.000Z`);
}

function civilPart(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`civil date ${field} must be a safe whole number`);
  return value;
}

/**
 * UTC-midnight Date for civil (year, monthIndex, day[, time]) parts — the
 * single replacement for `Date.UTC` with a variable year. Out-of-range parts
 * normalize EXACTLY like Date.UTC (month 12 rolls to January, day 0 is the
 * previous month's last day), so month-end and month-step call sites keep
 * their shape; only the 0-99 → 1900-1999 remap is gone. Non-integer parts
 * throw instead of producing NaN.
 */
export function utcDateFromParts(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  civilPart(year, "year");
  civilPart(monthIndex, "month");
  civilPart(day, "day");
  civilPart(hour, "hour");
  civilPart(minute, "minute");
  civilPart(second, "second");
  civilPart(ms, "millisecond");
  // Year/month/day FIRST, time parts second: an out-of-range time carries
  // into the date (hour 24 is the next day at 00:00), and setting the parts
  // in the other order lets setUTCFullYear overwrite the carried day.
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, ms);
  return date;
}

/**
 * Render a UTC Date's civil calendar day as zero-padded YYYY-MM-DD — the one
 * Date → ISO-date formatter. UTC getters, so a server's own timezone never
 * shifts the day.
 */
export function isoDateOf(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-`
    + `${String(date.getUTCMonth() + 1).padStart(2, "0")}-`
    + `${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Whole-day index of an ISO date (days since the Unix epoch, UTC), for
 * window overlap arithmetic. The input is validated exactly like
 * parseIsoDate (real calendar date, years 0001-9999), so garbage refuses
 * here instead of indexing a normalized neighbor.
 */
export function civilDayIndex(iso: string): number {
  parseIsoDate(iso);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  return Math.round(utcDateFromParts(year, month - 1, day).getTime() / 86_400_000);
}

/**
 * The ISO date a whole-day index denotes — the inverse of civilDayIndex.
 * Rendered from UTC getters (never toISOString), so the civil year survives
 * with no 1900 offset at any supported year.
 */
export function isoFromCivilDayIndex(day: number): string {
  calendarOffset(day);
  return isoDateOf(new Date(day * 86_400_000));
}

/** Whole calendar days from one ISO date to another (b - a; signed). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  return civilDayIndex(toIso) - civilDayIndex(fromIso);
}

/** Whole calendar days in the INCLUSIVE window [from, to] (both ISO dates). */
export function inclusiveCalendarDays(fromIso: string, toIso: string): number {
  return civilDayIndex(toIso) - civilDayIndex(fromIso) + 1;
}

/**
 * Last calendar day of a 1-based month, honoring leap years (0096 has a
 * February 29th; 0100 does not). Out-of-range months roll over exactly like
 * the `Date.UTC(year, month1, 0)` idiom this replaces.
 */
export function daysInCivilMonth(year: number, month1: number): number {
  return utcDateFromParts(year, month1, 0).getUTCDate();
}

/**
 * Zero-padded YYYY-MM-DD for civil (year, month1, day) parts. Parts
 * normalize exactly like Date.UTC (documented on utcDateFromParts) — callers
 * needing refusal of impossible dates validate first, via a parseIsoDate
 * round-trip.
 */
export function civilDateFromParts(year: number, month1: number, day: number): string {
  return isoDateOf(utcDateFromParts(year, month1 - 1, day));
}

function isoDay(date: Date): string {
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new RangeError("business date exceeds the supported calendar (0001 through 9999)");
  }
  return date.toISOString().slice(0, 10);
}

function calendarOffset(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError("calendar offset must be a safe whole number");
}

/** First day of the calendar month that contains `iso`. */
export function startOfMonth(iso: string): string {
  parseIsoDate(iso);
  return `${iso.slice(0, 7)}-01`;
}

/** Add (or subtract) whole calendar days on the YYYY-MM-DD grid. */
export function addCalendarDays(iso: string, days: number): string {
  calendarOffset(days);
  const date = parseIsoDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

/** Last day of the calendar month that contains `iso`. */
export function endOfMonth(iso: string): string {
  parseIsoDate(iso);
  const year = Number(iso.slice(0, 4));
  const month1 = Number(iso.slice(5, 7));
  return civilDateFromParts(year, month1, daysInCivilMonth(year, month1));
}

/**
 * First day of the calendar month `months` away from the month that contains
 * `iso` (negative steps back). The day of month is discarded: use this for
 * month-grid periods, never for anniversaries.
 */
export function addMonthsStart(iso: string, months: number): string {
  calendarOffset(months);
  const date = parseIsoDate(iso);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return isoDay(date);
}

/**
 * The same day of month `months` away (negative steps back), clamped to the
 * target month's last day: 2024-01-31 + 1 is 2024-02-29, and 2024-03-31 - 1
 * is 2024-02-29. The clamp is not sticky — stepping a clamped result again
 * starts from the clamped day — so a schedule of anniversaries steps from
 * its anchor (`addMonthsClamped(anchor, n)`), not from the previous result.
 */
export function addMonthsClamped(iso: string, months: number): string {
  calendarOffset(months);
  const day = parseIsoDate(iso).getUTCDate();
  const target = parseIsoDate(addMonthsStart(iso, months));
  const year = target.getUTCFullYear();
  const month1 = target.getUTCMonth() + 1;
  return civilDateFromParts(year, month1, Math.min(day, daysInCivilMonth(year, month1)));
}

/** Monday of the ISO week that contains `iso` (matches Postgres date_trunc('week')). */
export function mondayOfIsoWeek(iso: string): string {
  const date = parseIsoDate(iso);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return isoDay(date);
}

/** `weeks` consecutive Mondays ending with the week that contains `iso`, oldest first. */
export function weekStartsEndingOn(iso: string, weeks: number): string[] {
  calendarOffset(weeks);
  if (weeks < 0) throw new RangeError("week count must not be negative");
  const monday = parseIsoDate(mondayOfIsoWeek(iso));
  const starts: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const week = new Date(monday);
    week.setUTCDate(monday.getUTCDate() - i * 7);
    starts.push(isoDay(week));
  }
  return starts;
}

/** Inclusive calendar-quarter bounds for the quarter that contains `iso`. */
export function calendarQuarterBounds(iso: string): { start: string; end: string } {
  const date = parseIsoDate(iso);
  const quarter = Math.floor(date.getUTCMonth() / 3);
  const start = new Date(date);
  start.setUTCMonth(quarter * 3, 1);
  const end = new Date(date);
  end.setUTCMonth(quarter * 3 + 3, 0);
  return { start: isoDay(start), end: isoDay(end) };
}
