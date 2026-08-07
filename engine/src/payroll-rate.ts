import { sql, type SQL } from "drizzle-orm";

/**
 * The single definition of "which labor_cost_rates row pays this employee for
 * this run, and is it usable".
 *
 * Two places asked that question and answered it differently: readiness tested
 * whether any active rate row OVERLAPPED the pay period, while the run's
 * `resolvePayRate` takes the latest row that covers the period END, and
 * `calculateStub` additionally refuses a salaried employee whose effective row
 * is not `basis = 'year'`. A rate that ended mid-period, or a salaried employee
 * holding only an hourly rate, therefore passed readiness green and then threw
 * inside the run — the pre-flight validating a different rule from the thing it
 * is a pre-flight for.
 *
 * Two implementations of one rule IS the defect, so the rule lives here once:
 * `effectivePayRateSql` is the row selection, `hasUsablePayRateSql` is the
 * readiness predicate built from it, and `payRateIsUsable` is the same
 * decision in TypeScript so it is testable without a database.
 *
 * This module is a leaf — it imports nothing from the engine — so both
 * `payroll-run.ts` and `payroll-readiness.ts` can depend on it without a cycle.
 */

export type PayRateBasis = "hour" | "year";

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
 * salaried employee needs an ANNUAL row, because calculateStub divides the
 * annual rate by the schedule's periods per year and refuses anything else.
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
    and (${input.payBasis} <> 'salary' or ${basis} = 'year')
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
  return payBasis === "salary" ? rate.basis === "year" : true;
}
