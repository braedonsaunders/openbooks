import { sql } from 'drizzle-orm'
import { db } from './db.ts'
import { add, mulRate } from './money.ts'
import { evaluateUsNexus, type NexusEvaluation, type StateSales } from './us-nexus.ts'

/**
 * Aggregate US sales by destination state and evaluate economic nexus.
 *
 * Destination is taken from the customer's default US shipping address (the
 * ship-to state drives sales-tax nexus). Sales = posted customer invoices net of
 * credit memos over the window, converted to USD; the transaction count is
 * invoices only. Sales to customers with no US shipping address on file cannot
 * be placed and are returned separately so the number is honest rather than
 * silently dropped.
 */
export interface UsNexusResult {
  from: string
  to: string
  states: NexusEvaluation[]
  /** Posted US sales that could not be attributed to a state (no ship-to on file). */
  unattributed: { salesUsd: string; txnCount: number }
}

export async function computeUsNexusStatus(orgId: string, from: string, to: string): Promise<UsNexusResult> {
  const rows = (await db.execute<{
    state: string
    currency: string
    fx_rate: string
    base_currency: string
    amount: string
    is_invoice: number
    as_of: string
  }>(sql`
    select coalesce(a.region, '') as state,
           d.currency,
           d.fx_rate::text as fx_rate,
           o.base_currency,
           (case when d.kind = 'customer_credit' then -d.subtotal else d.subtotal end)::text as amount,
           case when d.kind = 'customer_invoice' then 1 else 0 end as is_invoice,
           coalesce(d.posting_date, d.document_date)::text as as_of
      from documents d
      join orgs o on o.id = d.org_id
      left join addresses a
        on a.party_id = d.party_id and a.is_default_shipping and a.country = 'US'
     where d.org_id = ${orgId}
       and d.kind in ('customer_invoice', 'customer_credit')
       and d.status = 'posted'
       and coalesce(d.posting_date, d.document_date) between ${from} and ${to}
  `))

  const usdByState = new Map<string, { sales: string; txnCount: number }>()
  const rateCache = new Map<string, string>()

  const usdRate = async (fromCurrency: string, asOf: string): Promise<string> => {
    const key = `${fromCurrency}|${asOf}`
    const cached = rateCache.get(key)
    if (cached) return cached
    const r = (await db.execute<{ rate: string }>(sql`
      select rate::text from (
        select rate, as_of from fx_rates
         where org_id = ${orgId} and from_currency = ${fromCurrency}
           and to_currency = 'USD' and rate_type = 'spot' and as_of <= ${asOf}
        union all
        select (1 / rate)::numeric(19,10) as rate, as_of from fx_rates
         where org_id = ${orgId} and from_currency = 'USD'
           and to_currency = ${fromCurrency} and rate_type = 'spot' and as_of <= ${asOf}
      ) candidates order by as_of desc limit 1`))
    const rate = r.rows[0]?.rate
    if (!rate) {
      throw new Error(`no spot rate for ${fromCurrency}→USD on or before ${asOf} — nexus thresholds are USD`)
    }
    rateCache.set(key, rate)
    return rate
  }

  for (const row of rows.rows) {
    let usd: string
    if (row.currency === 'USD') {
      usd = row.amount
    } else if (row.base_currency === 'USD' && row.fx_rate && row.fx_rate !== '1') {
      usd = mulRate(row.amount, row.fx_rate)
    } else {
      usd = mulRate(row.amount, await usdRate(row.currency, row.as_of))
    }
    const key = row.state.trim()
    const prev = usdByState.get(key) ?? { sales: '0', txnCount: 0 }
    usdByState.set(key, {
      sales: add(prev.sales, usd),
      txnCount: prev.txnCount + Number(row.is_invoice),
    })
  }

  const attributed: StateSales[] = []
  let unattributed = { salesUsd: '0', txnCount: 0 }
  for (const [state, agg] of usdByState) {
    if (state) attributed.push({ state: state.toUpperCase(), salesUsd: agg.sales, txnCount: agg.txnCount })
    else unattributed = { salesUsd: agg.sales, txnCount: agg.txnCount }
  }

  return { from, to, states: evaluateUsNexus(attributed), unattributed }
}
