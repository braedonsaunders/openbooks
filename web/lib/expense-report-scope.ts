import { sql, type SQL } from "drizzle-orm";
import type { ReportExpenseAccess } from "@openbooks/reports";

// SQL narrowing for analytics that read expense reports beside other
// documents. The reader's access comes from reportExpenseAccess.

/**
 * `and (...)` narrowing a documents query to the expense reports the reader
 * may read: nothing for an org-wide reader, the reports of their linked person
 * for a self-service reader, and no expense report otherwise. Other document
 * kinds are unaffected.
 */
export function expenseDocumentScope(access: ReportExpenseAccess, kind: SQL, party: SQL): SQL {
  if (access.scope === "all") return sql``;
  if (access.scope === "own" && access.partyId)
    return sql`and (${kind} is distinct from 'expense_report' or ${party} = ${access.partyId}::uuid)`;
  return sql`and ${kind} is distinct from 'expense_report'`;
}

/** The party label a ledger leg of an unreadable expense report shows instead of the employee. */
export const EXPENSE_RESTRICTED_PARTY_LABEL = "Employee expenses (restricted)";

/**
 * TRUE for a ledger leg sourced from an expense report the reader may not
 * read. Such a leg keeps its account and amount, so ledger totals still tie,
 * but not the employee, memo or report it came from.
 */
export function hiddenExpenseLeg(access: ReportExpenseAccess, kind: SQL, party: SQL): SQL {
  if (access.scope === "all") return sql`false`;
  if (access.scope === "own" && access.partyId)
    return sql`(coalesce(${kind}, '') = 'expense_report' and ${party} is distinct from ${access.partyId}::uuid)`;
  return sql`(coalesce(${kind}, '') = 'expense_report')`;
}
