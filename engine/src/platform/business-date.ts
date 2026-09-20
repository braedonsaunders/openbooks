import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { now } from "./clock.ts";

/**
 * Business "today" — the calendar day in the org's configured time zone.
 *
 * The scheduler and service defaults run on server time (UTC), but a posted
 * entry, dunning notice, or bank file dated near local midnight must land on
 * the org's calendar day, not the UTC day. The zone is read from the same
 * key close.ts uses for fiscal calendars (`orgs.settings->>'timeZone'`); an
 * absent or unrecognized zone falls back to the plain UTC day rather than
 * guessing. Defaults read `now()` (clock.ts) so a pinned simulation clock
 * keeps driving period-driven engines deterministically.
 */

const supportedZones: ReadonlySet<string> | null = (() => {
  if (typeof Intl.supportedValuesOf !== "function") return null;
  try {
    return new Set<string>(Intl.supportedValuesOf("timeZone"));
  } catch {
    return null;
  }
})();

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
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Accept only zones this runtime actually knows; anything else means UTC. */
function validZone(value: string | null | undefined): string | null {
  const zone = value?.trim();
  if (!zone) return null;
  if (supportedZones) return supportedZones.has(zone) ? zone : null;
  try {
    formatInZone(now(), zone);
    return zone;
  } catch {
    return null;
  }
}

/** The org's configured IANA time zone; UTC when it is absent or invalid. */
export async function businessTimeZone(orgId: string): Promise<string> {
  const r = (await db.execute<{ time_zone: string | null }>(sql`
    select settings->>'timeZone' as time_zone from orgs where id = ${orgId}
  `));
  return validZone(r.rows[0]?.time_zone) ?? "UTC";
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
