import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { parseISO, type OpenItem, type Side } from './core'

function subScope(col: ReturnType<typeof sql>, subIds?: string[]) {
  return subIds && subIds.length > 0
    ? sql` and ${col} = any(${`{${subIds.join(',')}}`}::uuid[])`
    : sql``
}

/**
 * Operational AR/AP items follow the document's current posting projection.
 * Reversed historical entries remain in the general ledger forever, but must
 * not become a second collectible/payable item after append-only correction.
 */
export async function openItems(
  orgId: string,
  side: Side,
  asOf: string,
  subIds?: string[],
): Promise<OpenItem[]> {
  const acctType = side === 'ar' ? 'asset_receivable' : 'liability_payable'
  const signFilter = side === 'ap' ? sql`jl.amount < 0` : sql`jl.amount > 0`
  const kindFilter = side === 'ap'
    ? sql`d.kind in ('vendor_bill', 'expense_report')`
    : sql`d.kind = 'customer_invoice'`
  const result = (await db.execute(sql`
    with oi as (
      select jl.id, jl.party_id, jl.entry_id, je.posting_date as tran_date, jl.due_date,
             je.source_document_id as doc_id,
             abs(jl.amount) - coalesce((
               select sum(x.amount) from applications x
                where x.org_id = ${orgId}
                  and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                  and x.unapplied_at is null
             ), 0) as remaining
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = ${orgId} and je.status = 'posted'
        join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
       where jl.is_open_item and a.type = ${acctType} and ${signFilter}
         and je.posting_date <= ${asOf}${subScope(sql`jl.subsidiary_id`, subIds)}
    )
    select oi.id, oi.entry_id, oi.doc_id, d.kind as doc_kind, d.document_number as doc_number, oi.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           oi.tran_date, oi.due_date, oi.remaining
      from oi
      join documents d on d.id = oi.doc_id and d.org_id = ${orgId}
       and d.posted_entry_id = oi.entry_id and d.status = 'posted' and ${kindFilter}
      left join parties p on p.id = oi.party_id
     where oi.remaining > 0.005
  `)) as any
  return (result.rows as any[]).map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    docKind: row.doc_kind ?? null,
    docNumber: row.doc_number ?? null,
    docId: row.doc_id ?? null,
    partyId: row.party_id,
    partyName: row.party_name,
    tranDate: parseISO(row.tran_date),
    dueDate: row.due_date ? parseISO(row.due_date) : null,
    remaining: Number(row.remaining),
  }))
}
