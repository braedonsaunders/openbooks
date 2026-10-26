import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import {
  openingHasMaterialHistorySql,
  readEmployeeOpeningLevySources,
} from "./opening-levy-source-reader.ts";

/** Retained source country governs historical wages and carry-ins; current employee settings cannot re-route them. */
export async function assertPayrollCountryKnown(
  executor: SqlExecutor,
  orgId: string,
  taxYear: number,
): Promise<void> {
  const stubs = await executor.execute<{ employee_party_id: string; display_name: string }>(
    sql`
    select distinct s.employee_party_id, p.display_name
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id and d.status<>'voided'
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and r.run_status = 'committed' and s.country is null
  `,
    "objects",
  );
  const materialHistory = await openingHasMaterialHistorySql("b");
  const openings = await executor.execute<{ employee_party_id: string; display_name: string }>(
    sql`
    select distinct b.employee_party_id, p.display_name
      from payroll_opening_balances b
      join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
     where b.org_id = ${orgId} and b.tax_year = ${taxYear}
       and ${materialHistory}
  `,
    "objects",
  );
  const unknown = new Map<string, string>();
  for (const row of stubs) unknown.set(row.employee_party_id, row.display_name);
  for (const row of openings) {
    let original: Awaited<ReturnType<typeof readEmployeeOpeningLevySources>>;
    try {
      original = await readEmployeeOpeningLevySources(executor, {
        orgId,
        employeePartyId: row.employee_party_id,
        taxYear,
      });
    } catch (error) {
      if (!(error instanceof PayrollError)) throw error;
      throw new PayrollError(`${row.display_name}: ${error.message}`, { cause: error });
    }
    if (!original.facts || !original.authority || !original.openingSnapshot) {
      unknown.set(row.employee_party_id, row.display_name);
    }
  }
  if (unknown.size > 0) {
    const names = [...unknown.values()].sort().join(", ");
    throw new PayrollError(
      `year-end payroll cannot be built: ${names} ${
        unknown.size === 1 ? "has" : "have"
      } payroll with an unknown historical country — committed stubs with no country, or a ` +
        "pre-adoption carry-in without its original country-qualified source. Review the original " +
        "payroll evidence and qualify the opening report in Payroll → Opening balances → Levy source. " +
        "A current employee country cannot replace historical source evidence.",
    );
  }
}
