import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { normalizeMoney } from '@openbooks/engine/money'
import { openItemSourceQuery } from '../cash/open-items'
import { presentationCurrency, presentationSpotRatesSql, presentationAmountSql, MissingExchangeRateError } from '../fx-presentation'
import { analyticsQuery } from './query'
import { currentAnalyticsRead, analyticsSection } from './read-context'
import { cachedAnalyticsRead } from './preview-cache'
import { receivablesRatio } from './receivables-metrics'
import { AGING_BUCKET_UPPER_DAYS } from '../aging-basis'

export interface ReceivableCohort {
  index: number
  gross: string
  credits: string
  net: string
  documents: number
  averageDays: string | null
}
export interface ReceivableCustomer {
  id: string | null
  name: string
  gross: string
  credits: string
  net: string
  overdue: string
  severe: string
  documents: number
}
export interface ReceivablesSummary {
  outstanding: string
  gross: string
  credits: string
  overdue: string
  severe: string
  overdueShare: string | null
  averageOverdueDays: string | null
  documents: number
  customers: number
  top5Share: string | null
  missingTerms: string
  aging: ReceivableCohort[]
  maturity: ReceivableCohort[]
}
export interface ReceivablesData {
  asOf: string
  currency: string
  summary: ReceivablesSummary
  customers: ReceivableCustomer[]
}

async function translatedSource(orgId: string, asOf: string, scope: ReadonlySet<string> | null, base: string): Promise<SQL> {
  const population = await openItemSourceQuery(orgId, 'ar', asOf, scope === null ? undefined : [...scope].sort())
  const spots = presentationSpotRatesSql(orgId, base, sql`select distinct coalesce(func, ${base}) as ccy from population`, asOf)
  const amount = presentationAmountSql(sql`p.remaining`, sql`coalesce(p.func, ${base})`, base, sql`r.rate::numeric`)
  return sql`
    population as materialized (${population}),
    rates as (${spots}),
    translated as materialized (
      select p.*, ${amount} as amount,
             (${asOf}::date - coalesce(p.due_date, p.tran_date)::date) as age,
             (coalesce(p.due_date, p.tran_date)::date - ${asOf}::date) as due_in
      from population p left join rates r on r.from_currency = coalesce(p.func, ${base})
    ),
    missing as (
      select distinct coalesce(p.func, ${base}) as currency from population p
      left join rates r on r.from_currency = coalesce(p.func, ${base})
      where coalesce(p.func, ${base}) <> ${base} and (r.rate is null or r.rate::numeric <= 0)
    )`
}

function refuseMissing(missing: string[], base: string, asOf: string): void {
  if (missing.length) throw new MissingExchangeRateError(missing[0]!, base, asOf, missing)
}

/** Aggregate the complete historical population before projecting a bounded
 * payload. Currency conversion rounds each control line exactly as the cash
 * cockpit does, before any customer or age grouping. */
async function calculateSummary(source: SQL, currency: string, asOf: string): Promise<ReceivablesSummary> {
  const agingIndex = sql`case ${sql.join(AGING_BUCKET_UPPER_DAYS.map((days, index) => sql`when age <= ${days} then ${index}`), sql` `)} else 4 end`
  const result = await analyticsQuery<{
    outstanding: string; gross: string; credits: string; overdue: string; severe: string
    weighted_days: string; missing_terms: string; documents: number; customers: number
    top5: string; aging: ReceivableCohort[]; maturity: ReceivableCohort[]; missing: string[]
  }>(sql`with ${source},
    customer_balances as (
      select party_id, sum(greatest(amount, 0)) as gross from translated group by party_id
    ),
    cohorts as (
      select *, ${agingIndex} as aging_index,
             case when due_in < 0 then 0 when due_in <= 7 then 1 when due_in <= 14 then 2 when due_in <= 30 then 3 when due_in <= 60 then 4 when due_in <= 90 then 5 else 6 end as maturity_index
      from translated
    ),
    aging as (
      select aging_index as index, sum(greatest(amount, 0))::text as gross,
             sum(greatest(-amount, 0))::text as credits, sum(amount)::text as net,
             count(distinct doc_id)::int as documents,
             round(sum(greatest(amount, 0) * greatest(age, 0)) / nullif(sum(greatest(amount, 0)), 0), 1)::text as "averageDays"
      from cohorts group by aging_index
    ),
    maturity as (
      select maturity_index as index, sum(greatest(amount, 0))::text as gross,
             sum(greatest(-amount, 0))::text as credits, sum(amount)::text as net,
             count(distinct doc_id)::int as documents, null::text as "averageDays"
      from cohorts group by maturity_index
    )
    select coalesce(sum(amount), 0)::text as outstanding,
           coalesce(sum(greatest(amount, 0)), 0)::text as gross,
           coalesce(sum(greatest(-amount, 0)), 0)::text as credits,
           coalesce(sum(greatest(amount, 0)) filter (where age > 0), 0)::text as overdue,
           coalesce(sum(greatest(amount, 0)) filter (where age > ${AGING_BUCKET_UPPER_DAYS[3]}), 0)::text as severe,
           coalesce(sum(greatest(amount, 0) * age) filter (where age > 0), 0)::text as weighted_days,
           coalesce(sum(greatest(amount, 0)) filter (where due_date is null), 0)::text as missing_terms,
           count(distinct doc_id)::int as documents,
           count(distinct party_id)::int as customers,
           coalesce((select sum(gross) from (select gross from customer_balances order by gross desc, party_id nulls last limit 5) top), 0)::text as top5,
           coalesce((select jsonb_agg(aging order by index) from aging), '[]'::jsonb) as aging,
           coalesce((select jsonb_agg(maturity order by index) from maturity), '[]'::jsonb) as maturity,
           coalesce((select jsonb_agg(currency order by currency) from missing), '[]'::jsonb) as missing
    from translated`)
  const row = result.rows[0]!
  refuseMissing(row.missing, currency, asOf)
  const gross = normalizeMoney(row.gross), overdue = normalizeMoney(row.overdue)
  const fill = (rows: ReceivableCohort[], count: number) => Array.from({ length: count }, (_, index) => {
    const found = rows.find((r) => r.index === index)
    return found ? { ...found, gross: normalizeMoney(found.gross), credits: normalizeMoney(found.credits), net: normalizeMoney(found.net) }
      : { index, gross: '0.0000', credits: '0.0000', net: '0.0000', documents: 0, averageDays: null }
  })
  return {
    outstanding: normalizeMoney(row.outstanding), gross, credits: normalizeMoney(row.credits), overdue,
    severe: normalizeMoney(row.severe), documents: row.documents, customers: row.customers,
    overdueShare: receivablesRatio(overdue, gross), top5Share: receivablesRatio(row.top5, gross),
    averageOverdueDays: receivablesRatio(row.weighted_days, overdue), missingTerms: normalizeMoney(row.missing_terms),
    aging: fill(row.aging, 5), maturity: fill(row.maturity, 7),
  }
}

async function customerExposure(source: SQL, currency: string, asOf: string): Promise<ReceivableCustomer[]> {
  const result = await analyticsQuery<{ customers: ReceivableCustomer[]; missing: string[] }>(sql`with ${source},
    grouped as (
      select party_id as id, max(party_name) as name,
             sum(greatest(amount, 0))::text as gross, sum(greatest(-amount, 0))::text as credits,
             sum(amount)::text as net, coalesce(sum(greatest(amount, 0)) filter (where age > 0), 0)::text as overdue,
             coalesce(sum(greatest(amount, 0)) filter (where age > ${AGING_BUCKET_UPPER_DAYS[3]}), 0)::text as severe,
             count(distinct doc_id)::int as documents
      from translated group by party_id
    ), ranked as (select * from grouped order by overdue::numeric desc, gross::numeric desc, id nulls last limit 12)
    select coalesce((select jsonb_agg(ranked order by overdue::numeric desc, gross::numeric desc, id nulls last) from ranked), '[]'::jsonb) as customers,
           coalesce((select jsonb_agg(currency order by currency) from missing), '[]'::jsonb) as missing`)
  const row = result.rows[0]!
  refuseMissing(row.missing, currency, asOf)
  return row.customers.map((r) => ({ ...r, gross: normalizeMoney(r.gross), credits: normalizeMoney(r.credits), net: normalizeMoney(r.net), overdue: normalizeMoney(r.overdue), severe: normalizeMoney(r.severe) }))
}

export async function receivablesData(orgId: string, asOf: string, scope: ReadonlySet<string> | null): Promise<ReceivablesData> {
  const currency = await presentationCurrency(orgId)
  const source = await translatedSource(orgId, asOf, scope, currency)
  const read = currentAnalyticsRead()
  const load = () => calculateSummary(source, currency, asOf)
  const summary = read?.slug === 'receivables-intelligence' && read.authz.user.orgId === orgId
    ? await cachedAnalyticsRead(read.authz, 'metric:receivables', { asOf, scope: scope === null ? 'all' : [...scope].sort().join(',') }, load, { identity: read, admit: false })
    : await load()
  const customers = analyticsSection('receivables-intelligence', ['customers']) ? await customerExposure(source, currency, asOf) : []
  return { asOf, currency, summary, customers }
}
