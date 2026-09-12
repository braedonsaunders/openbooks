import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";

/** Expense reports identify the employee even when a card funds the expense.
 * A former employee can still submit and receive their final reimbursement;
 * party/role deactivation must not erase an employee liability.
 */
export async function assertExpenseEmployee(
  runner: SqlExecutor,
  document: { kind: string; orgId: string; partyId: string | null },
): Promise<void> {
  if (document.kind !== "expense_report") return;
  if (!document.partyId) throw new Error("an expense report requires an employee before submission or posting");
  const employee = await runner.execute<{ id: string }>(sql`
    select p.id from parties p
     where p.org_id = ${document.orgId} and p.id = ${document.partyId}
       and exists (
         select 1 from employee_roles er
          where er.org_id = p.org_id and er.party_id = p.id
       )
  `);
  if (!employee.rows[0]) {
    throw new Error("an expense report requires an employee in this organization before submission or posting");
  }
}
