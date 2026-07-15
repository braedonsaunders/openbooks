import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getAuthz } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Rich read-only detail for one journal entry, used by the reports EntryFlyout
 * so drilling from a statement opens the transaction as a flyout (not the bare
 * /journal/[id] table). Returns the entry header, its source document (so the
 * flyout can escalate to the full editable transaction drawer), and every line
 * enriched with account/party/dimension names.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  const e = (await db.execute(sql`
    select e.id, e.entry_number, e.posting_date::text as date, e.memo, e.origin, e.status,
           e.source_document_id,
           re.entry_number as reverses_number,
           d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number
      from journal_entries e
      left join journal_entries re on re.id = e.reverses_entry_id
      left join documents d on d.id = e.source_document_id
     where e.id = ${id}
  `)) as unknown as { rows: Record<string, unknown>[] }
  const entry = e.rows[0]
  if (!entry) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const lines = (await db.execute(sql`
    select l.line_number, l.amount, l.memo, l.is_open_item,
           a.id as account_id, a.number as account_number, a.name as account_name,
           p.display_name as party, d.name as department, pr.name as project
      from journal_lines l
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join departments d on d.id = l.department_id
      left join projects pr on pr.id = l.project_id
     where l.entry_id = ${id}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }

  return NextResponse.json({ entry, lines: lines.rows })
}
