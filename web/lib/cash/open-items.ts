import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { mulDecimal } from '@openbooks/engine/src/money.ts'
import { lineFunctional, presentationCurrency, presentationRates } from '../fx-presentation'
import { normalizeMoneyValue, parseISO, type OpenItem, type Side } from './core'

function subScope(col: ReturnType<typeof sql>, subIds?: string[]) {
  return subIds !== undefined
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
  const creditKind = side === 'ap' ? 'vendor_credit' : 'customer_credit'
  // Bills/invoices carry the side's normal sign; credit memos carry the
  // opposite sign on the same control account. Both are open items: an
  // unapplied credit is a negative payable/receivable that nets against the
  // party's bills (the aging report already nets it — the forecast must too,
  // or scheduled outflow overstates cash need).
  const lineFilter = side === 'ap'
    ? sql`((d.kind = ${creditKind} and jl.amount > 0) or (d.kind <> ${creditKind} and jl.amount < 0))`
    : sql`((d.kind = ${creditKind} and jl.amount < 0) or (d.kind <> ${creditKind} and jl.amount > 0))`
  const kindFilter = side === 'ap'
    ? sql`d.kind in ('vendor_bill', 'expense_report', ${creditKind})`
    : sql`d.kind in ('customer_invoice', ${creditKind})`
  // `remaining` reconstructs what was still collectible AS OF the forecast
  // date — gross line minus applications dated on/before it (an application
  // unapplied only after the date still counted then). Netting live
  // applications instead would let a later settlement rewrite a past forecast,
  // and gating on the live cached open_balance would hide documents settled
  // after the date that were open on it.
  const result = (await db.execute(sql`
    with oi as (
      select jl.id, jl.party_id, jl.entry_id, je.posting_date as tran_date, jl.due_date,
             d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number,
             sub.base_currency as func,
             (case when d.kind = ${creditKind} then -1 else 1 end) * (abs(jl.amount) - coalesce((
               select sum(x.amount) from applications x
                where x.org_id = ${orgId}
                  and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                  and x.applied_on <= ${asOf}
                  and (x.unapplied_at is null or x.unapplied_at::date > ${asOf}::date)
             ), 0)) as remaining
        from documents d
        join journal_entries je on je.id = d.posted_entry_id and je.org_id = ${orgId} and je.status = 'posted'
         and je.posting_date <= ${asOf}
        join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and ${lineFilter}
        join accounts a on a.id = jl.account_id and a.org_id = ${orgId} and a.type = ${acctType}
        left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
       where d.org_id = ${orgId} and d.status = 'posted' and ${kindFilter}
         ${subScope(sql`jl.subsidiary_id`, subIds)}
    )
    select oi.id, oi.entry_id, oi.doc_id, oi.doc_kind, oi.doc_number, oi.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           oi.tran_date, oi.due_date, oi.remaining, oi.func
      from oi
      left join parties p on p.id = oi.party_id and p.org_id = ${orgId}
     where oi.remaining <> 0
  `))
  // `remaining` nets in the line entity's functional currency (legs are
  // stamped functional; applications.amount is target-functional and the sign
  // filter keeps only target-side control lines). A consolidated view spans
  // functionals, so each item translates to the presentation currency at the
  // closing spot — raw functionals would mix subsidiary currencies. One rate
  // lookup per functional in view; missing coverage fails closed.
  const rows = result.rows as any[]
  const base = await presentationCurrency(orgId)
  const rates = await presentationRates(orgId, base, rows.map((row) => row.func ?? null), asOf)
  return rows.map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    docKind: row.doc_kind ?? null,
    docNumber: row.doc_number ?? null,
    docId: row.doc_id ?? null,
    partyId: row.party_id,
    partyName: row.party_name,
    tranDate: parseISO(row.tran_date),
    dueDate: row.due_date ? parseISO(row.due_date) : null,
    // PostgreSQL numeric values are returned as decimal text. Keep that text
    // exact at the boundary; converting to Number would round valid
    // numeric(19,4) balances before the forecast has a chance to aggregate
    // them.
    remaining: normalizeMoneyValue(mulDecimal(String(row.remaining), rates.get(lineFunctional(row.func ?? null, base))!)),
  }))
}
