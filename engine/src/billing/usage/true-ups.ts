import type { UsageCommitPeriod } from "./rating-plans.ts";

export interface CommitWindow {
  start: string;
  end: string;
}

/** Returns the exact usage window that a minimum commitment closes. */
export function commitWindowForRun(
  periodStart: string,
  periodEnd: string,
  commitPeriod: UsageCommitPeriod | null,
): CommitWindow | null {
  if (commitPeriod === null) return null;
  if (commitPeriod === "monthly") return { start: periodStart, end: periodEnd };

  // Annual minimums use calendar years. Only the run whose inclusive window
  // ends on December 31 closes that commit year.
  if (!/^\d{4}-12-31$/.test(periodEnd)) return null;
  return { start: `${periodEnd.slice(0, 4)}-01-01`, end: periodEnd };
}
