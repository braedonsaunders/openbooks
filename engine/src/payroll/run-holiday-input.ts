import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalNonNegativeDecimal, isPositiveDecimal } from "../money/exact-decimal.ts";
import { PayrollError } from "./error.ts";
import { resolvePayRate } from "./run-calculation-support.ts";
import { payrollHourlyWage } from "./rate.ts";
import { priceDatedWageEntries } from "./wage-rounding.ts";

/** Paid holiday units use the run's dated wage; cash is never an operator input. */
export async function priceRunHolidayHours(tx: SqlExecutor, input: {
  orgId: string; documentId: string; employeePartyId: string; hours: string;
}): Promise<string> {
  const hours = canonicalNonNegativeDecimal(input.hours, 2);
  if (hours === null || !isPositiveDecimal(hours)) {
    throw new PayrollError("Recorded holiday pay requires positive paid hours with at most two decimal places.");
  }
  const runs = await tx.execute<{ period_end: string; currency: string }>(sql`
    select r.period_end::text, d.currency
      from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
     where r.org_id=${input.orgId} and r.document_id=${input.documentId}
  `);
  const run = runs.rows[0];
  if (runs.rows.length !== 1 || !run?.currency) throw new PayrollError("The holiday input requires a pay run with a resolved currency.");
  const wage = await resolvePayRate(tx, input.orgId, input.employeePartyId, run.period_end, run.currency);
  if (!wage) throw new PayrollError("The paid holiday hours have no dated native wage; configure the employee's wage for this pay period.");
  const priced = priceDatedWageEntries(payrollHourlyWage(wage), "1", [{ workedOn: run.period_end, hours }], wage);
  if (priced.days.length !== 1) throw new PayrollError("The paid holiday hours did not resolve to one native wage calculation.");
  return priced.days[0]!.amount;
}
