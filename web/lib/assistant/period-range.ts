import { resolvePreset, type DateRange } from "@openbooks/reports";

/**
 * Date-window inputs shared by every range-taking assistant tool. The model
 * may pass a named fiscal-aware `period` preset (resolved server-side with
 * the org's fiscal start month — the same resolver as the report filter bar)
 * or an explicit fromDate/toDate pair for genuinely custom windows. Pure and
 * DB-free so the precedence rules are unit-testable.
 */
export type RangeArgs = { period?: string; fromDate?: string; toDate?: string };

export function resolveRangeArgs(
  a: RangeArgs,
  startMonth: number,
  today: string,
): DateRange | { error: string } {
  if (a.period) {
    const range = resolvePreset(a.period, { startMonth, today });
    if (!range) return { error: "invalid_period" };
    return range;
  }
  if (!a.fromDate || !a.toDate) return { error: "period_or_date_range_required" };
  if (a.fromDate > a.toDate) return { error: "invalid_period" };
  return { from: a.fromDate, to: a.toDate, label: `${a.fromDate} – ${a.toDate}` };
}
