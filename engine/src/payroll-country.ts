import { sql } from "drizzle-orm";
import { type SqlExecutor } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";

/** Unknown legacy attribution must not silently disappear from a tax return. */
export async function assertPayrollCountryKnown(
  executor: SqlExecutor, orgId: string, taxYear: number,
): Promise<void> {
  const result = await executor.execute(sql`
    select s.id from pay_stubs s
    join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and r.run_status = 'committed' and s.country is null
     limit 1
  `);
  if (result.rows.length > 0) {
    throw new PayrollError("Committed payroll has an unknown historical country. Review its original payroll evidence before generating year-end reports.");
  }
}
