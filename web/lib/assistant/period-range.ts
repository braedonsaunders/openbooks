import { resolvePreset, type DateRange } from "@openbooks/reports";
import { addMonthsClamped } from "@openbooks/engine/src/platform/civil-date.ts";

/**
 * Date-window inputs shared by every range-taking assistant tool. The model
 * may pass a named fiscal-aware `period` preset (resolved server-side with
 * the org's fiscal start month — the same resolver as the report filter bar)
 * or an explicit fromDate/toDate pair for genuinely custom windows. Pure and
 * DB-free so the precedence rules are unit-testable.
 */
export type RangeArgs = { period?: string; fromDate?: string; toDate?: string; priorYears?: number };

export function resolveRangeArgs(
  a: RangeArgs,
  startMonth: number,
  today: string,
): DateRange | { error: string } {
  const base = resolveBaseRange(a, startMonth, today);
  if ("error" in base) return base;
  const years = a.priorYears ?? 0;
  if (!Number.isInteger(years) || years < 0 || years > 10) return { error: "invalid_period" };
  if (years === 0) return base;
  // Same window, N fiscal years earlier: every fiscal/calendar boundary
  // repeats yearly, so a plain year shift keeps the window on its own
  // period edges (Q1 FY2027 → Q1 FY2026, "FY to date" → prior-year to date).
  return {
    from: addMonthsClamped(base.from, -12 * years),
    to: addMonthsClamped(base.to, -12 * years),
    label: `${base.label} (${years === 1 ? "prior year" : `${years} years earlier`})`,
  };
}

function resolveBaseRange(a: RangeArgs, startMonth: number, today: string): DateRange | { error: string } {
  if (a.period) {
    const range = resolvePreset(a.period, { startMonth, today });
    if (!range) return { error: "invalid_period" };
    return range;
  }
  if (!a.fromDate || !a.toDate) return { error: "period_or_date_range_required" };
  if (a.fromDate > a.toDate) return { error: "invalid_period" };
  return { from: a.fromDate, to: a.toDate, label: `${a.fromDate} – ${a.toDate}` };
}
