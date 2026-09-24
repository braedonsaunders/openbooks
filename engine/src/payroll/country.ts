import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

/**
 * Unknown legacy attribution must not silently disappear from a tax return —
 * and must not silently BECOME the return of a country it never belonged to.
 *
 * Two year-end inputs can carry an unknown country, and neither may fall
 * through to Canada (or anywhere else):
 *
 * - committed stubs whose own country was never stamped (`pay_stubs.country`
 *   is nullable for legacy rows);
 * - mid-year-adopter carry-ins whose employee has NO payroll profile row.
 *   A profile row always carries a country (NOT NULL since the baseline), so
 *   a missing row is the only unknown here — and it is also the most
 *   dangerous one: the year-end readers join openings to profiles BY country,
 *   so without this guard the carry-in is either dropped by an inner join or
 *   folded into Canada by a `coalesce`, both silently.
 *
 * The refusal names every affected employee, so the operator fixes the set in
 * one pass. Only rows that actually move a year-end box are in scope: an
 * all-zero opening row is inert in every reader and must not block the year,
 * so the guard repeats the readers' own nonzero predicate (keep the three in
 * lockstep: here, `openingYearEndYtdByEmployee`, and the RL-1's
 * `openingRl1YtdByEmployee`).
 */
export async function assertPayrollCountryKnown(
  executor: SqlExecutor, orgId: string, taxYear: number,
): Promise<void> {
  const stubs = await executor.execute<{ employee_party_id: string; display_name: string }>(sql`
    select distinct s.employee_party_id, p.display_name
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and r.run_status = 'committed' and s.country is null
  `);
  const openings = await executor.execute<{ employee_party_id: string; display_name: string }>(sql`
    select distinct b.employee_party_id, p.display_name
      from payroll_opening_balances b
      join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
      left join employee_payroll_profiles prof
        on prof.org_id = b.org_id and prof.employee_party_id = b.employee_party_id
     where b.org_id = ${orgId} and b.tax_year = ${taxYear}
       and prof.employee_party_id is null
       and (
         coalesce(b.pensionable_ytd, 0) <> 0 or coalesce(b.insurable_ytd, 0) <> 0
         or coalesce(b.cpp_ytd, 0) <> 0 or coalesce(b.cpp2_ytd, 0) <> 0
         or coalesce(b.ei_ytd, 0) <> 0 or coalesce(b.qpip_ytd, 0) <> 0
         or coalesce(b.taxable_ytd, 0) <> 0 or coalesce(b.tax_ytd, 0) <> 0
         or coalesce(b.fica_withheld_ytd, 0) <> 0
       )
  `);
  const unknown = new Map<string, string>();
  for (const row of [...stubs.rows, ...openings.rows]) {
    unknown.set(row.employee_party_id, row.display_name);
  }
  if (unknown.size > 0) {
    const names = [...unknown.values()].sort().join(", ");
    throw new PayrollError(
      `year-end payroll cannot be built: ${names} ${
        unknown.size === 1 ? "has" : "have"
      } payroll with an unknown historical country — committed stubs with no country, or a `
      + "pre-adoption carry-in with no payroll profile to attribute it to. No country is assumed: "
      + "review the original payroll evidence, set each employee's country on their Payroll tab, "
      + "and rebuild the year-end reports.",
    );
  }
}
