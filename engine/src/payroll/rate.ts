import { sql, type SQL } from "drizzle-orm";
import { annualPayRate, isTimePayRateBasis, type PayRateBasis } from "../projects/pay-rate-basis.ts";
import { divideMoney } from "./run-allocation.ts";
import type { Money } from "../money/brands.ts";

/**
 * The single definition of "which labor_cost_rates row pays this employee for
 * this run, is it usable, and what does it pay".
 *
 * Readiness and the run must answer the same question the same way: the run's
 * `resolvePayRate` takes the latest row that covers the period END, and a
 * salaried employee can only be paid from a rate quoted per stretch of time
 * (week, two weeks, half-month, month or year) — an hourly rate has no
 * per-period amount. `effectivePayRateSql` is the row selection,
 * `hasUsablePayRateSql` is the readiness predicate built from it, and
 * `payRateIsUsable` is the same decision in TypeScript so it is testable
 * without a database. `salaryPeriodPay` and `payrollHourlyWage` are the
 * amounts the run pays from that row, through the shared pay-rate cadence
 * conversion.
 *
 * This module depends only on leaf helpers, so both the run and readiness can
 * depend on it without a cycle.
 */

export type { PayRateBasis };

/**
 * The rate row `resolvePayRate` would return: active, effective on `onDate`,
 * latest `effective_from` wins. `selectList` is spliced into the subquery so a
 * caller can ask for the whole row or just one column.
 */
export function effectivePayRateSql(input: {
  org: SQL;
  employee: SQL;
  onDate: SQL | string;
  selectList: SQL;
}): SQL {
  return sql`(
    select ${input.selectList}
      from labor_cost_rates w
     where w.org_id = ${input.org} and w.employee_party_id = ${input.employee}
       and w.is_active and w.effective_from <= ${input.onDate}
       and (w.effective_to is null or w.effective_to >= ${input.onDate})
     order by w.effective_from desc
     limit 1
  )`;
}

/**
 * Boolean: the run will find a rate it can actually pay this employee on.
 * `payBasis` is the employee_payroll_profiles.pay_basis expression — a
 * salaried employee needs a time-based row (any basis except `hour`), because
 * calculateStub annualizes that rate and divides it by the schedule's periods
 * per year, and refuses an hourly rate.
 */
export function hasUsablePayRateSql(input: {
  org: SQL;
  employee: SQL;
  onDate: SQL | string;
  payBasis: SQL;
}): SQL {
  const basis = effectivePayRateSql({ ...input, selectList: sql`w.basis` });
  return sql`(
    ${basis} is not null
    and (${input.payBasis} <> 'salary' or ${basis} <> 'hour')
  )`;
}

/**
 * The same decision in TypeScript. `rate` is the effective row (null when no
 * active rate covers the date) — exactly what `resolvePayRate` returns.
 */
export function payRateIsUsable(
  payBasis: string | null,
  rate: { basis: PayRateBasis } | null,
): boolean {
  if (!rate) return false;
  return payBasis === "salary" ? isTimePayRateBasis(rate.basis) : true;
}

/** The pay-rate fields the run pays from: the effective row, FX-converted. */
export interface PayableRate {
  readonly basis: PayRateBasis;
  readonly rate: string;
  readonly annualHours: string;
}

/**
 * One period's salary: the rate's annual amount divided by the schedule's
 * periods per year, rounded once to the cent. A yearly rate pays exactly
 * rate ÷ periods; a monthly rate on a semimonthly schedule pays
 * (rate × 12) ÷ 24. Only a time-based rate can be paid as salary.
 */
export function salaryPeriodPay(rate: PayableRate, periodsPerYear: number): Money {
  if (!isTimePayRateBasis(rate.basis)) {
    throw new Error("a salary is paid from a time-based rate; an hourly rate has no per-period amount");
  }
  return divideMoney(annualPayRate(rate.rate, rate.basis, rate.annualHours), String(periodsPerYear), 2);
}

/**
 * The hourly wage the run prices time with: an hourly rate as stored, a
 * time-based rate annualized and divided by the row's annual hours, rounded
 * once to four decimals. That quotient IS the stored hourly wage multiplied
 * by every hour on every stub, so it is computed exactly, never through a
 * float reciprocal.
 */
export function payrollHourlyWage(rate: PayableRate): string {
  if (rate.basis === "hour") return rate.rate;
  return divideMoney(annualPayRate(rate.rate, rate.basis, rate.annualHours), rate.annualHours, 4);
}
