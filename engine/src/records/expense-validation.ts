import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * An expense-report submission/posting refusal: the report names no employee,
 * names a non-employee, has no corporate card for funded lines, or names
 * another tenant's card. Callers map this to a 4xx — a request-state failure,
 * never a server defect. (This lives in records rather than reusing
 * flows' SubmitError because records may not import flows under
 * engine/src/modules.json; both map to 422 at the API boundary, and the
 * posting kernel wraps it into PostingError.)
 */
export class ExpenseValidationError extends Error {
  readonly name = "ExpenseValidationError";
}

/**
 * Settlement coherence for an expense report (0171): company-paid and personal
 * lines are funded by the report's corporate card, so they require one — and
 * the card must belong to this org (the documents FK is global, so without an
 * org-scoped check a draft could name another tenant's card and die only at
 * posting). Runs at submit and again at posting, so legacy approved reports
 * that never passed the current submission boundary still fail closed.
 */
export async function assertExpenseSettlement(
  runner: SqlExecutor,
  document: { kind: string; orgId: string; id: string; paymentCardId: string | null },
): Promise<void> {
  if (document.kind !== "expense_report") return;
  const funded = await runner.execute<{ one: number }>(sql`
    select 1 as one from document_lines
     where org_id = ${document.orgId} and document_id = ${document.id}
       and settlement_type in ('company_paid', 'personal')
     limit 1`);
  if (!funded.rows[0]) return;
  if (!document.paymentCardId) {
    throw new ExpenseValidationError("company-paid and personal expense lines require a corporate card on the report");
  }
  // No is_active gate: deactivating a card must not brick an in-flight report
  // (data entry already restricts the picker to active cards; the cardRule
  // posting path likewise books the liability without an active check).
  const card = await runner.execute<{ id: string }>(sql`
    select id from payment_cards
     where org_id = ${document.orgId} and id = ${document.paymentCardId}`);
  if (!card.rows[0]) {
    throw new ExpenseValidationError("the report's corporate card was not found in this organization");
  }
}

/** Expense reports identify the employee even when a card funds the expense.
 * A former employee can still submit and receive their final reimbursement;
 * party/role deactivation must not erase an employee liability.
 */
export async function assertExpenseEmployee(
  runner: SqlExecutor,
  document: { kind: string; orgId: string; partyId: string | null },
): Promise<void> {
  if (document.kind !== "expense_report") return;
  if (!document.partyId) throw new ExpenseValidationError("an expense report requires an employee before submission or posting");
  const employee = await runner.execute<{ id: string }>(sql`
    select p.id from parties p
     where p.org_id = ${document.orgId} and p.id = ${document.partyId}
       and exists (
         select 1 from employee_roles er
          where er.org_id = p.org_id and er.party_id = p.id
       )
  `);
  if (!employee.rows[0]) {
    throw new ExpenseValidationError("an expense report requires an employee in this organization before submission or posting");
  }
}
