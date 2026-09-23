import { sql } from 'drizzle-orm'
import { db } from '../platform/db.ts'
import { add, mulRate, normalizeDecimal, roundMoney } from '../money/money.ts'
import { IncomeTaxProvisionError, spotRateToPresentation } from './income-tax-provision.ts'
import { uuidArray } from '../organization/subsidiaries.ts'
import { evaluateUsNexus, thresholdForState, type NexusEvaluation, type StateNexusThreshold, type StateSales } from '../tax/us-nexus.ts'

/** Role-derived subsidiary visibility; null/undefined means unrestricted. */
export type UsNexusSubsidiaryScope = ReadonlySet<string> | null | undefined

/**
 * Restrict legal-entity-owned documents to the caller's visible subsidiaries.
 * A present empty set is deliberately deny-all; posted documents with no
 * subsidiary also fail closed for restricted callers.
 */
function subsidiaryScopeFilter(allowedSubsidiaryIds: UsNexusSubsidiaryScope) {
  if (allowedSubsidiaryIds == null) return sql``
  const ids = [...allowedSubsidiaryIds]
  return ids.length > 0
    ? sql`and d.subsidiary_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
    : sql`and false`
}

/**
 * Options for a filing-entity nexus ledger. Nexus obligations attach to legal
 * entities, not to the org blend: `subsidiaryIds` scopes the aggregation to
 * one filing entity and the ledger measures in that entity's working currency
 * instead of the org-wide USD default.
 */
export interface UsNexusLedgerOptions {
  /** Subsidiaries forming the filing entity; ANDed with visibility scope. */
  subsidiaryIds?: string[]
  /**
   * Working currency: row conversion target and threshold expression currency.
   * Defaults to the entity's single functional currency (an entity spanning
   * several functional currencies must declare one explicitly); unscoped
   * ledgers default to USD, the threshold reference currency.
   */
  currency?: string
  /** fx_rates `rate_type` for row conversion and threshold translation. */
  rateType?: string
  /** Rate effective date (ISO); defaults to the window end (`to`). */
  rateDate?: string
}

export interface UsNexusTranslation {
  rateType: string
  rateDate: string
  /** Effective date of the applied USD→working rate row. */
  rateAsOf: string
  /** The policy rate the USD reference thresholds were translated at. */
  usdToCurrencyRate: string
}

const NEXUS_CURRENCY_RE = /^[A-Z]{3}$/
const NEXUS_RATE_TYPE_RE = /^[a-z][a-z0-9_]{1,31}$/
const NEXUS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function resolveEntityScope(
  orgId: string,
  opts: UsNexusLedgerOptions,
): Promise<{ subsidiaryIds: string[] | null; currency: string }> {
  const rateType = opts.rateType ?? 'spot'
  if (!NEXUS_RATE_TYPE_RE.test(rateType)) {
    throw new Error(`nexus rateType "${opts.rateType}" is not a valid rate source`)
  }
  if (opts.rateDate !== undefined && !NEXUS_DATE_RE.test(opts.rateDate)) {
    throw new Error(`nexus rateDate "${opts.rateDate}" is not an ISO date (YYYY-MM-DD)`)
  }
  if (opts.currency !== undefined && !NEXUS_CURRENCY_RE.test(opts.currency)) {
    throw new Error(`nexus currency "${opts.currency}" is not a valid 3-letter currency code`)
  }
  if (!opts.subsidiaryIds) return { subsidiaryIds: null, currency: opts.currency ?? 'USD' }
  if (opts.subsidiaryIds.length === 0) {
    throw new Error('nexus filing entity must name at least one subsidiary')
  }
  const ids = [...new Set(opts.subsidiaryIds)]
  try {
    uuidArray(ids)
  } catch (e) {
    throw new Error(`nexus filing entity names an invalid subsidiary id (${e instanceof Error ? e.message : String(e)})`)
  }
  const rows = (await db.execute<{ id: string; base_currency: string; is_elimination: boolean }>(sql`
    select id, base_currency, is_elimination from subsidiaries
     where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])`))
  const known = new Set(rows.rows.map((r) => r.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Error(`nexus filing entity references subsidiaries outside this organization: ${unknown.join(', ')}`)
  }
  const elimination = rows.rows.filter((r) => r.is_elimination)
  if (elimination.length > 0) {
    throw new Error('nexus filing entity cannot include an elimination entity — only legal filers hold nexus')
  }
  if (!opts.currency) {
    const currencies = [...new Set(rows.rows.map((r) => r.base_currency))]
    if (currencies.length > 1) {
      throw new Error(
        `nexus filing entity spans functional currencies (${currencies.sort().join(' and ')}) — pass currency to declare the working currency`,
      )
    }
    return { subsidiaryIds: ids, currency: currencies[0]! }
  }
  return { subsidiaryIds: ids, currency: opts.currency }
}

/**
 * Aggregate US sales by destination state and evaluate economic nexus.
 *
 * Destination is the jurisdiction the sale was taxed/posted with, frozen on
 * the document at posting (0265 ship-to snapshot; the ship-to state drives
 * sales-tax nexus), falling back to the first line's provider-quote evidence
 * for rows posted before the stamp existed. The live address book is NEVER
 * consulted: attributing history to the customer's CURRENT address moved
 * prior sales across states whenever an address changed. Sales = posted
 * customer invoices net of credit memos over the window, converted to the
 * working currency; the transaction count is invoices only. Sales with no
 * captured destination cannot be placed and are returned separately with
 * their count, while known non-US destinations are outside this US ledger.
 *
 * The working currency is USD for the org-wide ledger (thresholds apply
 * directly, byte-identical to the historical behaviour). A filing-entity ledger
 * measures in the entity's working currency with the USD reference thresholds
 * translated at the declared policy rate — reported back as `translation`
 * evidence — and fails closed when rate coverage is missing.
 */
export interface UsNexusResult {
  from: string
  to: string
  /** Working currency: `states`/`unattributed` amounts are denominated here. */
  currency: string
  /** The filing entity measured, or null for the org-wide ledger. */
  subsidiaryIds: string[] | null
  states: NexusEvaluation[]
  /** Posted US sales that could not be attributed to a state (no captured destination). */
  unattributed: { salesUsd: string; txnCount: number }
  /** Threshold-translation evidence; null when thresholds applied directly (USD). */
  translation: UsNexusTranslation | null
}

export async function computeUsNexusStatus(
  orgId: string,
  from: string,
  to: string,
  allowedSubsidiaryIds?: UsNexusSubsidiaryScope,
  opts: UsNexusLedgerOptions = {},
): Promise<UsNexusResult> {
  const rateType = opts.rateType ?? 'spot'
  const rateDate = opts.rateDate ?? to
  const entity = await resolveEntityScope(orgId, opts)
  const target = entity.currency
  const entityFilter =
    entity.subsidiaryIds === null
      ? sql``
      : sql`and d.subsidiary_id in (${sql.join(entity.subsidiaryIds.map((id) => sql`${id}`), sql`, `)})`
  const rows = (await db.execute<{
    state: string
    currency: string
    fx_rate: string
    base_currency: string
    amount: string
    is_invoice: number
    as_of: string
  }>(sql`
    select case when upper(trim(coalesce(d.ship_to_country, q.country, ''))) = 'US'
                then coalesce(d.ship_to_region, q.region, '') else '' end as state,
           d.currency,
           d.fx_rate::text as fx_rate,
           o.base_currency,
           (case when d.kind = 'customer_credit' then -d.subtotal else d.subtotal end)::text as amount,
           case when d.kind = 'customer_invoice' then 1 else 0 end as is_invoice,
           coalesce(d.posting_date, d.document_date)::text as as_of
      from documents d
      join orgs o on o.id = d.org_id
      -- Quote evidence for rows posted before the ship-to stamp existed
      -- (0265): the destination the line's tax was actually computed for,
      -- first line wins — the same read order the backfill and the posting
      -- stamp use, so all three agree when lines disagree.
      left join lateral (
        select q.ship_to->>'country' as country, q.ship_to->>'region' as region
          from document_lines dl
          join tax_rate_quotes q
            on q.org_id = dl.org_id
           and q.document_line_id = dl.id
         where dl.org_id = d.org_id
           and dl.document_id = d.id
         order by dl.line_number, dl.id
         limit 1
      ) q on true
     where d.org_id = ${orgId}
       and d.kind in ('customer_invoice', 'customer_credit')
       and d.status = 'posted'
       and coalesce(d.posting_date, d.document_date) between ${from} and ${to}
       ${subsidiaryScopeFilter(allowedSubsidiaryIds)}
       ${entityFilter}
       -- Foreign destinations are outside US nexus. A document whose frozen
       -- destination is unknown stays unattributed with its count, but a
       -- known non-US destination is never treated as an unplaceable US sale
       -- — and nothing here reads the live address book, so editing an
       -- address can never move already-posted sales across states.
       and (
         nullif(trim(coalesce(d.ship_to_country, q.country, '')), '') is null
         or upper(trim(coalesce(d.ship_to_country, q.country, ''))) = 'US'
       )
  `))

  const byState = new Map<string, { sales: string; txnCount: number }>()
  const rateCache = new Map<string, Promise<string>>()

  const rateToTarget = (fromCurrency: string, asOf: string): Promise<string> => {
    const key = `${fromCurrency}|${asOf}`
    const cached = rateCache.get(key)
    if (cached) return cached
    const lookup = (async () => {
      try {
        return (await spotRateToPresentation(db, orgId, fromCurrency, target, asOf, rateType)).rate
      } catch (e) {
        if (e instanceof IncomeTaxProvisionError) {
          throw new Error(
            `no ${rateType} rate for ${fromCurrency}→${target} on or before ${asOf} — configure exchange rates before measuring nexus in ${target}`,
          )
        }
        throw e
      }
    })()
    rateCache.set(key, lookup)
    return lookup
  }

  for (const row of rows.rows) {
    let converted: string
    if (row.currency === target) {
      converted = row.amount
    // A stored rate is authoritative only when it differs from the column
    // default at the column's own ten-decimal scale. The numeric(19,10) value
    // reads back as '1.0000000000', so a raw string comparison against '1'
    // treated every unstamped legacy rate as a real 1:1 peg and converted at
    // 1.0 instead of resolving the rate below — the same default-vs-set
    // distinction the posting kernel draws before honouring a header rate.
    } else if (row.base_currency === target && row.fx_rate && normalizeDecimal(row.fx_rate, 10) !== '1.0000000000') {
      converted = mulRate(row.amount, row.fx_rate)
    } else {
      converted = mulRate(row.amount, await rateToTarget(row.currency, row.as_of))
    }
    const key = row.state.trim()
    const prev = byState.get(key) ?? { sales: '0', txnCount: 0 }
    byState.set(key, {
      sales: add(prev.sales, converted),
      txnCount: prev.txnCount + Number(row.is_invoice),
    })
  }

  const attributed: StateSales[] = []
  let unattributed = { salesUsd: '0', txnCount: 0 }
  for (const [state, agg] of byState) {
    if (state) attributed.push({ state: state.toUpperCase(), salesUsd: agg.sales, txnCount: agg.txnCount })
    else unattributed = { salesUsd: agg.sales, txnCount: agg.txnCount }
  }

  // Thresholds are USD reference data. In the USD working currency they apply
  // directly (the historical path — no lookup, no evidence object). Otherwise
  // each state's dollar trigger translates once at the declared policy rate;
  // the coarse whole-dollar figures round to cents for the numeric threshold
  // field while the measured sales keep full ledger precision.
  if (target === 'USD') {
    return { from, to, currency: target, subsidiaryIds: entity.subsidiaryIds, states: evaluateUsNexus(attributed), unattributed, translation: null }
  }
  let policyRate: string
  let policyAsOf: string
  try {
    ({ rate: policyRate, asOf: policyAsOf } = await spotRateToPresentation(db, orgId, 'USD', target, rateDate, rateType))
  } catch (e) {
    if (e instanceof IncomeTaxProvisionError) {
      throw new Error(
        `cannot translate nexus thresholds USD→${target} (${e.message})`,
      )
    }
    throw e
  }
  const thresholds = new Map<string, StateNexusThreshold>()
  for (const sale of attributed) {
    const reference = thresholdForState(sale.state)
    thresholds.set(
      sale.state,
      reference.measure === 'none' || reference.salesUsd === 0
        ? reference
        : { ...reference, salesUsd: Number(roundMoney(mulRate(String(reference.salesUsd), policyRate), 2)) },
    )
  }
  return {
    from,
    to,
    currency: target,
    subsidiaryIds: entity.subsidiaryIds,
    states: evaluateUsNexus(attributed, { thresholds }),
    unattributed,
    translation: { rateType, rateDate, rateAsOf: policyAsOf, usdToCurrencyRate: policyRate },
  }
}
