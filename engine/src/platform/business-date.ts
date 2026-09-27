import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { now } from "./clock.ts";
import { canonicalTimeZone } from "./time-zone.ts";
export { isIsoCalendarDate } from "./iso-date.ts";
export {
  addCalendarDays,
  addMonthsClamped,
  addMonthsStart,
  calendarDaysBetween,
  calendarQuarterBounds,
  civilDateFromParts,
  civilDayIndex,
  daysInCivilMonth,
  endOfMonth,
  inclusiveCalendarDays,
  isoDateOf,
  isoFromCivilDayIndex,
  mondayOfIsoWeek,
  parseIsoDate,
  startOfMonth,
  utcDateFromParts,
  weekStartsEndingOn,
} from "./civil-date.ts";

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
