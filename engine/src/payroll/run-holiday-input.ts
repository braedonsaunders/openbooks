import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalNonNegativeDecimal, isZeroDecimal } from "../money/exact-decimal.ts";
import { PayrollError } from "./error.ts";
import { resolvePayRate } from "./run-calculation-support.ts";
import { payrollHourlyWage } from "./rate.ts";
import { priceDatedWageEntries } from "./wage-rounding.ts";

/** Paid holiday units use the run's dated wage; cash is never an operator input. */
export async function priceRunHolidayHours(tx: SqlExecutor, input: {
  orgId: string; documentId: string; employeePartyId: string; hours: string; earnedOn?: string;
}): Promise<string> {
  const hours = canonicalNonNegativeDecimal(input.hours, 2);
  if (hours === null) {
    throw new PayrollError("Recorded holiday pay requires non-negative paid hours with at most two decimal places.");
  }
  const runs = await tx.execute<{ period_start: string; period_end: string; currency: string }>(sql`
    select r.period_start::text, r.period_end::text, d.currency
      from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
     where r.org_id=${input.orgId} and r.document_id=${input.documentId}
  `);
  const run = runs.rows[0];
  if (runs.rows.length !== 1 || !run?.currency) throw new PayrollError("The holiday input requires a pay run with a resolved currency.");
  if (input.earnedOn !== undefined && (!isIsoCalendarDate(input.earnedOn)
    || input.earnedOn < run.period_start || input.earnedOn > run.period_end)) {
    throw new PayrollError("Record holiday hours on one valid YYYY-MM-DD date within this pay period.");
  }
  // An explicit zero input suppresses additional holiday earnings; it does
  // not assert an absence or require a wage calculation with no cash impact.
  if (isZeroDecimal(hours)) return "0.00";
  const wage = await resolvePayRate(tx, input.orgId, input.employeePartyId, run.period_end, run.currency);
  if (!wage) throw new PayrollError("The paid holiday hours have no dated native wage; configure the employee's wage for this pay period.");
  const priced = priceDatedWageEntries(payrollHourlyWage(wage), "1", [{ workedOn: run.period_end, hours }], wage);
  if (priced.days.length !== 1) throw new PayrollError("The paid holiday hours did not resolve to one native wage calculation.");
  return priced.days[0]!.amount;
}
