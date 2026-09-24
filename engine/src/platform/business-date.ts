import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { now } from "./clock.ts";
import { canonicalTimeZone } from "./time-zone.ts";

/**
 * Business "today" — the calendar day in the org's configured time zone.
 *
 * The scheduler and service defaults run on server time (UTC), but a posted
 * entry, dunning notice, or bank file dated near local midnight must land on
 * the org's calendar day, not the UTC day. The zone is read from the same
 * key close.ts uses for fiscal calendars (`orgs.settings->>'timeZone'`); an
 * absent zone falls back to the plain UTC day rather than guessing, while a
 * stored value no runtime accepts refuses by name instead of silently
 * mis-dating on UTC. Defaults read `now()` (clock.ts) so a pinned
 * simulation clock keeps driving period-driven engines deterministically.
 */

/**
 * Format an instant as YYYY-MM-DD in an IANA zone — pure, so tests need no
 * database. formatToParts avoids any float date arithmetic and any reliance
 * on locale date ordering.
 */
export function formatInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  // `year: "numeric"` renders years below 1000 unpadded ("96", "999"), which
  // breaks the YYYY-MM-DD contract (and parseIsoDate) for business dates in
  // years 0001-0999. Month and day are "2-digit" and need no padding.
  return `${value("year").padStart(4, "0")}-${value("month")}-${value("day")}`;
}

/**
 * Format an instant's wall-clock time as HHMM (24-hour) in an IANA zone —
 * pure, so tests need no database. Bank-file creation stamps (NACHA HHMM,
 * SEPA CreDtTm) must render in an EXPLICIT zone: reading getHours() off the
 * Date inherits whatever timezone the server happens to run in.
 */
export function formatTimeInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  // en-CA midnight formats as "24:00" on some runtimes; normalize to 00.
  const hour = value("hour") === "24" ? "00" : value("hour");
  return `${hour}${value("minute")}`;
}

/**
 * Format an instant as a zone-local ISO timestamp YYYY-MM-DDTHH:MM:SS
 * (no offset suffix — the receiver reads it in the originating bank's local
 * time, exactly like the NACHA header). Pure.
 */
export function formatTimestampInZone(date: Date, timeZone: string): string {
  const hhmm = formatTimeInZone(date, timeZone);
  return `${formatInZone(date, timeZone)}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00`;
}

/**
 * The org's configured IANA time zone: the canonical name when a zone is
 * stored (aliases resolve through the shared validator, so a stored
 * "US/Eastern" days as America/New_York); UTC when no zone is stored. An
 * org id with no row is a caller bug, not a UTC org — it refuses by name
 * so the wrong tenant never silently inherits the UTC day. A stored value
 * no runtime accepts is a misconfigured org, not a UTC org — it refuses by
 * name so the operator fixes the setting instead of posting on the wrong day.
 */
export async function businessTimeZone(orgId: string): Promise<string> {
  const r = (await db.execute<{ time_zone: string | null }>(sql`
    select settings->>'timeZone' as time_zone from orgs where id = ${orgId}
  `));
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      `organization ${orgId} not found — cannot resolve its business time zone`,
    );
  }
  const stored = row.time_zone;
  if (!stored || !stored.trim()) return "UTC";
  const canonical = canonicalTimeZone(stored);
  if (!canonical) {
    throw new Error(
      `Stored business time zone ${JSON.stringify(stored)} is not a known IANA time zone — set Business time zone in Company Settings → Organization`,
    );
  }
  return canonical;
}

/** The org's business day (YYYY-MM-DD); UTC day when no valid zone is set. */
export async function businessToday(orgId: string): Promise<string> {
  return formatInZone(now(), await businessTimeZone(orgId));
}

/** Parse YYYY-MM-DD as a UTC calendar date — no local-timezone shift. */
export function parseIsoDate(iso: string): Date {
  const date = typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T00:00:00.000Z`)
    : new Date(NaN);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1
      || date.toISOString().slice(0, 10) !== iso) {
    throw new RangeError("business date must be a valid YYYY-MM-DD calendar date in years 0001 through 9999");
  }
  return date;
}

/** Boolean boundary for forms that report invalid dates instead of throwing. */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { parseIsoDate(value); return true; }
  catch { return false; }
}

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
// (ISO-string parsing is exact for years 0001-9999), and difference through
// calendarDaysBetween / inclusiveCalendarDays.
// scripts/check-civil-date-arithmetic.mjs refuses Date.UTC / multi-arg
// new Date with a non-literal year anywhere else, so the next site cannot
// regress silently.

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

/** Render a UTC Date's civil calendar day as zero-padded YYYY-MM-DD. */
function isoDayOf(date: Date): string {
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
  return isoDayOf(new Date(day * 86_400_000));
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
  return isoDayOf(utcDateFromParts(year, month1 - 1, day));
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

/** First day of the calendar month `months` before the month that contains `iso`. */
export function addCalendarMonthsStart(iso: string, months: number): string {
  calendarOffset(months);
  const date = parseIsoDate(iso);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return isoDay(date);
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
