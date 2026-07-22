import { sql } from 'drizzle-orm'
import { db } from './db.ts'
import { evaluateUsNexus, type NexusEvaluation, type StateSales } from './us-nexus.ts'

/**
 * Aggregate US sales by destination state and evaluate economic nexus.
 *
 * Destination is taken from the customer's default US shipping address (the
 * ship-to state drives sales-tax nexus). Sales = posted customer invoices net of
 * credit memos over the window; the transaction count is invoices only. Sales to
 * customers with no US shipping address on file cannot be placed and are returned
 * separately so the number is honest rather than silently dropped.
 */
export interface UsNexusResult {
  from: string
  to: string
  states: NexusEvaluation[]
  /** Posted US sales that could not be attributed to a state (no ship-to on file). */
  unattributed: { salesUsd: number; txnCount: number }
}

export async function computeUsNexusStatus(orgId: string, from: string, to: string): Promise<UsNexusResult> {
  const rows = (await db.execute(sql`
    with sales as (
      select d.id, d.party_id,
             case when d.kind = 'customer_credit' then -d.subtotal else d.subtotal end as amount,
             case when d.kind = 'customer_invoice' then 1 else 0 end as is_invoice
        from documents d
       where d.org_id = ${orgId}
         and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'posted'
         and coalesce(d.posting_date, d.document_date) between ${from} and ${to}
    )
    select coalesce(a.region, '') as state,
           coalesce(sum(s.amount), 0)::text as sales_usd,
           coalesce(sum(s.is_invoice), 0)::int as txn_count
      from sales s
      left join addresses a
        on a.party_id = s.party_id and a.is_default_shipping and a.country = 'US'
     group by coalesce(a.region, '')`)) as unknown as {
    rows: { state: string; sales_usd: string; txn_count: number }[]
  }

  const attributed: StateSales[] = []
  let unattributed = { salesUsd: 0, txnCount: 0 }
  for (const r of rows.rows) {
    const salesUsd = Number(r.sales_usd)
    const txnCount = Number(r.txn_count)
    if (r.state && r.state.trim()) attributed.push({ state: r.state.trim().toUpperCase(), salesUsd, txnCount })
    else unattributed = { salesUsd, txnCount }
  }

  return { from, to, states: evaluateUsNexus(attributed), unattributed }
}
