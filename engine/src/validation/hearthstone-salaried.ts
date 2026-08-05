/** One-shot: convert Hearthstone employees to salary + recalc open runs. */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { calculatePayRun } from "../payroll-run.ts";

const ORG = "9c484d30-6e69-489d-af9b-59e44aa59f82";
const ACTOR = "53ad1d00-457e-4460-adc0-ca5ec9b84734";
const SALARIES: [string, string][] = [
  ["fe8fc150-e4f0-44b5-89ef-f599a6e16217", "108000"], // Renee Walsh
  ["afb16db3-35e8-4bc4-bb0d-150987832ab0", "92000"],  // Omar Khalil
  ["a50bfe2b-1178-4fbb-9bf2-87f2949d58bf", "81000"],  // Grace Liu
  ["cdea6eb3-9f62-4829-9674-e9eb9cd5b1b4", "68500"],  // Derek Cole
];
for (const [partyId, annual] of SALARIES) {
  await db.execute(sql`
    update labor_cost_rates set basis = 'year', rate = ${annual}
     where org_id = ${ORG} and employee_party_id = ${partyId}`);
  await db.execute(sql`
    update employee_payroll_profiles set pay_basis = 'salary'
     where org_id = ${ORG} and employee_party_id = ${partyId}`);
}
const open = (await db.execute(sql`
  select r.document_id, d.document_number from pay_runs r
  join documents d on d.id = r.document_id
  where r.org_id = ${ORG} and r.run_status in ('draft','calculated') and d.status = 'draft'
`)) as unknown as { rows: { document_id: string; document_number: string }[] };
for (const run of open.rows) {
  const result = await calculatePayRun({ orgId: ORG, documentId: run.document_id, actorId: ACTOR });
  console.log(`${run.document_number}: ${result.employees} stubs`, result.errors.length ? result.errors : "");
}
process.exit(0);
