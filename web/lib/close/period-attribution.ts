/**
 * Who closed a period and when each module was locked. Pure and client-safe:
 * the period list loads the raw columns and this module decides the closer and
 * parses the per-module lock dates, so the attribution rules have one home.
 */

export interface PeriodCloser {
  name: string;
  /** UTC calendar date (YYYY-MM-DD) of the close. */
  on: string;
}

/**
 * The closer of a period. A published or closed run names the user who closed
 * it. A period closed by locks alone (autopilot, API) names the user who took
 * the most recent lock. An open period has no closer.
 */
export function periodCloser(input: {
  runStatus: string | null;
  runCloserName: string | null;
  runClosedOn: string | null;
  lockCloserName: string | null;
  lockClosedOn: string | null;
}): PeriodCloser | null {
  const runClosed = input.runStatus === "closed" || input.runStatus === "published";
  if (runClosed && input.runCloserName && input.runClosedOn) {
    return { name: input.runCloserName, on: input.runClosedOn };
  }
  if (input.lockCloserName && input.lockClosedOn) {
    return { name: input.lockCloserName, on: input.lockClosedOn };
  }
  return null;
}

/**
 * Module → lock date from the aggregated `module:YYYY-MM-DD,…` string. Entries
 * without a date are skipped: an undated module shows as locked without a date.
 */
export function parseLockDates(raw: string | null): Map<string, string> {
  const dates = new Map<string, string>();
  for (const entry of String(raw ?? "").split(",")) {
    const [module, on] = entry.split(":");
    if (module && on) dates.set(module, on);
  }
  return dates;
}
