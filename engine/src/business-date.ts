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

/** The org's business day (YYYY-MM-DD); UTC day when no valid zone is set. */
export async function businessToday(orgId: string): Promise<string> {
  const r = (await db.execute<{ time_zone: string | null }>(sql`
    select settings->>'timeZone' as time_zone from orgs where id = ${orgId}
  `));
  return formatInZone(now(), validZone(r.rows[0]?.time_zone) ?? "UTC");
}
