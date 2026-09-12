import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'

/**
 * One statement gives the drawer one MVCC snapshot of its header, lines and
 * exact revision. A later token lookup could bless stale content with a
 * concurrent writer's revision and defeat optimistic concurrency.
 */
export async function loadExpenseReport(id: string, orgId: string) {
  const result = await db.execute<Record<string, unknown> & { __lines: Record<string, unknown>[] }>(sql`
    select d.*, ${documentRevisionSql(sql`d.updated_at`)} as updated_at,
           p.display_name as employee_name, e.id as entry_id,
           coalesce((
             select jsonb_agg(to_jsonb(line) order by line.line_number)
               from (
                 select l.id, l.line_number, l.account_id, l.description,
                        l.amount::text as amount, l.tax_code_id, l.tax_group_id,
                        l.tax_input_amount::text as tax_input_amount,
                        l.tax_amount::text as tax_amount, l.tax_overridden,
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
