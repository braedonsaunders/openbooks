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
