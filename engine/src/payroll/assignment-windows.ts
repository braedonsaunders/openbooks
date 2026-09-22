import { sql, type SQL } from "drizzle-orm";

/**
 * The ONE overlap predicate between a recurring assignment window
 * (`employee_pay_components`) and a pay period.
 *
 * An assignment applies when its window touches the period: it started on or
 * before the period ends, and it has not ended (or ends on or after the
 * period starts). In particular an assignment ending MID-period still
 * applies — the employee worked part of the period under it.
 *
 * Shared by the stub computation (which pays it) and readiness (which
 * promises it): the two previously disagreed — readiness used
 * `effective_to >= period_start` while the stub required
 * `effective_to >= period_end` — so a mid-period-ended assignment passed
 * pre-flight and was then silently left off the cheque.
 */
export function assignmentOverlapsPeriod(
  effectiveFrom: SQL,
  effectiveTo: SQL,
  periodStart: string,
  periodEnd: string,
): SQL {
  return sql`${effectiveFrom} <= ${periodEnd}
    and (${effectiveTo} is null or ${effectiveTo} >= ${periodStart})`;
}

/** Whole calendar days in the INCLUSIVE window [from, to] (both ISO dates). */
export function inclusiveDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000) + 1;
}

/**
 * The assignment window's coverage of a pay period, in whole calendar days
 * on the same inclusive basis the 0250 guard stores windows ('[]'): an
 * effective_to of the 15th covers THROUGH the 15th, and a successor starting
 * the 16th covers FROM the 16th, so the two slices of an amended component
 * sum to exactly one period.
 *
 * A null effective_to is open-ended and covers through the period end.
 */
export function assignmentCoveredDays(args: {
  effectiveFrom: string;
  effectiveTo: string | null;
  periodStart: string;
  periodEnd: string;
}): { coveredDays: number; periodDays: number } {
  const from = args.effectiveFrom > args.periodStart ? args.effectiveFrom : args.periodStart;
  const through = args.effectiveTo == null || args.effectiveTo > args.periodEnd
    ? args.periodEnd
    : args.effectiveTo;
  return {
    coveredDays: through >= from ? inclusiveDays(from, through) : 0,
    periodDays: inclusiveDays(args.periodStart, args.periodEnd),
  };
}

/**
 * Whether the assignment window covers the whole period: it started on or
 * before the period did and it ends on or after the period does (or never
 * ends). Fully-covering rows pay their full value with no proration math,
 * so their lines are byte-identical to an unwindowed component.
 */
export function assignmentCoversPeriod(args: {
  effectiveFrom: string;
  effectiveTo: string | null;
  periodStart: string;
  periodEnd: string;
}): boolean {
  return args.effectiveFrom <= args.periodStart
    && (args.effectiveTo == null || args.effectiveTo >= args.periodEnd);
}
