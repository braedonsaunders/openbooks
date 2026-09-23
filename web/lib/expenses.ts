import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { documentRevisionCounterSql } from '@openbooks/engine/src/records/revision.ts'

/**
 * Recall eligibility for an expense report (F-user-003): a pending_approval
 * or approved-but-unposted report is editable via recall — Edit cancels the
 * open gates and returns it to draft. Only the submitter (or document
 * author for legacy rows with no recorded submitter) or an org admin may
 * recall; the recall action re-checks authoritatively. A report with a void
 * in flight stays with the void flow. Shared by the reports page and the
 * related-transaction drawer.
 */
export function canRecallExpenseReport(
  doc: {
    status?: unknown
    submitted_by?: unknown
    created_by?: unknown
    void_requested_at?: unknown
  },
  user: {
    id: string
    roles: ReadonlyArray<{ key: string }>
    isSuperAdmin?: boolean
  },
): boolean {
  // The author fallback is legacy-only: once a submitter is recorded, the
  // creator (possibly a different person) must not see recall affordances
  // for another user's submission.
  const isSubmitter =
    doc.submitted_by === user.id || (doc.submitted_by == null && doc.created_by === user.id)
  return (
    (doc.status === 'pending_approval' || doc.status === 'approved') &&
    doc.void_requested_at == null &&
    (isSubmitter || user.isSuperAdmin === true || user.roles.some(({ key }) => key === 'admin'))
  )
}

/**
 * One statement gives the drawer one MVCC snapshot of its header, lines and
 * exact revision. A later token lookup could bless stale content with a
 * concurrent writer's revision and defeat optimistic concurrency.
 */
export async function loadExpenseReport(id: string, orgId: string) {
  const result = await db.execute<Record<string, unknown> & { __lines: Record<string, unknown>[] }>(sql`
    select d.*, ${documentRevisionCounterSql(sql`d.revision_seq`)} as updated_at,
           p.display_name as employee_name, e.id as entry_id,
           coalesce((
             select jsonb_agg(to_jsonb(line) order by line.line_number)
               from (
                 select l.id, l.line_number, l.account_id, l.description,
                        l.amount::text as amount, l.tax_code_id, l.tax_group_id,
                        l.tax_input_amount::text as tax_input_amount,
                        l.tax_amount::text as tax_amount, l.tax_overridden,
                        l.settlement_type,
                        l.department_id, l.project_id, l.extra_dims, l.custom
                   from document_lines l
                  where l.document_id = d.id and l.org_id = d.org_id
               ) line
           ), '[]'::jsonb) as "__lines"
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = 'expense_report'
  `)
  if (!result.rows[0]) return null
  const { __lines: lines, ...doc } = result.rows[0]
  return { doc, lines }
}
