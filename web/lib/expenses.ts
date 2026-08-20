import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Expense-report loaders. Tax/totals math and document numbering are shared
 * with AP (see ./bills.ts — taxProfileMap, computeBillTotals, nextDocumentNumber);
 * only the kind-scoped payload query lives here.
 */

/** Full expense report payload for the drawer: header + lines. */
export async function loadExpenseReport(id: string, orgId: string) {
  const doc = (await db.execute<Record<string, unknown>>(sql`
    select d.*, p.display_name as employee_name, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = 'expense_report'
  `))
  if (!doc.rows[0]) return null
  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.id, l.line_number, l.account_id, l.description, l.amount, l.tax_code_id,
           l.tax_group_id, l.tax_input_amount, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.extra_dims, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${orgId}
     order by l.line_number
  `))
  return { doc: doc.rows[0], lines: lines.rows }
}
