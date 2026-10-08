import 'server-only'

import { sql, type SQL } from 'drizzle-orm'
import { activePostingPrimaryBookId } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { addCalendarDays } from '@openbooks/engine/platform/civil-date'
import { normalizeMoney } from '@openbooks/engine/money'
import { openItemSourceQuery } from '../cash/open-items'
import { customerOrderCommitmentsSource } from '../customer-credit'
import { presentationCurrency, presentationSpotRatesSql, presentationAmountSql, MissingExchangeRateError } from '../fx-presentation'
import { analyticsConfig } from './config'
import { analyticsQuery } from './query'
import { analyticsSection, currentAnalyticsRead } from './read-context'
import { cachedAnalyticsRead } from './preview-cache'
import { receivablesRatio } from './receivables-metrics'

export interface CollectionCustomer {
  id: string | null; name: string; gross: string; credits: string; net: string; overdue: string; severe: string
  documents: number; overdueDocuments: number; oldestDays: number; missingTerms: string
  recentDays: string | null; baselineDays: string | null; changeDays: string | null
  observations: number; baselineObservations: number; onTimeShare: string | null; deteriorating: boolean
  delivered: number; failed: number; suppressed: number; lastNotice: string | null
  creditLimit: string | null; committed: string; unbilled: string; headroom: string | null; held: boolean; holdReason: string | null
  history: { date: string; days: string | null }[]
}
export interface CollectionSummary {
  customers: number; overdueCustomers: number; attentionCustomers: number; attention: string; overdue: string
  deterioratingCustomers: number; deterioratingExposure: string; onTimeShare: string | null; observations: number
  opening: string; recovered: string; recoveryShare: string | null; remaining: string; otherChange: string
  failedExposure: string; deliveredDocuments: number; overdueDocuments: number; coverageShare: string | null
  missingTerms: string; unassigned: string; credits: string
  heldCustomers: number; heldExposure: string; limitCustomers: number; overLimitCustomers: number; overLimit: string
  behavior: { index: number; amount: string; documents: number }[]
  notices: { status: string; documents: number }[]
}
export interface CollectionRecovery { index: number; opening: string; cash: string; remaining: string; other: string }
export interface CollectionTrend { date: string; amount: string; days: string | null; documents: number }
export interface ReceivablesIntelligence {
  from: string; asOf: string; currency: string; currentCredit: boolean; baselineDays: number; minObservations: number
  summary: CollectionSummary; customers: CollectionCustomer[]; customerTotal: number; customerPage: number
  recovery: CollectionRecovery[]; trend: CollectionTrend[]
}

const PAGE_SIZE = 24
const moneyFields = ['gross', 'credits', 'net', 'overdue', 'severe', 'missingTerms', 'committed', 'unbilled'] as const
function normalizeCustomer(row: CollectionCustomer): CollectionCustomer {
  return { ...row, ...Object.fromEntries(moneyFields.map((key) => [key, normalizeMoney(row[key])])),
    creditLimit: row.creditLimit === null ? null : normalizeMoney(row.creditLimit), headroom: row.headroom === null ? null : normalizeMoney(row.headroom) }
}

/** A single scoped population supplies summary, customer cards and chart
 * projections. Applications retain target carrying amounts; only posted
 * customer receipts count as cash recovery or payment observations. */
async function collectionSource(orgId: string, from: string, asOf: string, scope: ReadonlySet<string> | null, currency: string) {
  const [cfg, bookId, today, closing, opening] = await Promise.all([
    analyticsConfig(orgId, 'receivables'), activePostingPrimaryBookId(orgId), businessToday(orgId),
    openItemSourceQuery(orgId, 'ar', asOf, scope === null ? undefined : [...scope].sort()),
    openItemSourceQuery(orgId, 'ar', addCalendarDays(from, -1), scope === null ? undefined : [...scope].sort()),
  ])
  const recentFrom = addCalendarDays(asOf, 1 - cfg.baselineDays)
  const baselineFrom = addCalendarDays(recentFrom, -cfg.baselineDays)
  const historyFrom = baselineFrom < from ? baselineFrom : from
  const scoped = (column: SQL) => scope === null ? sql`` : sql`and ${column} = any(${`{${[...scope].sort().join(',')}}`}::uuid[])`
  const isCurrent = asOf === today
  const orderSource = customerOrderCommitmentsSource(orgId, scope)
  const orderRates = presentationSpotRatesSql(orgId, currency, sql`select coalesce(o.func, ${currency}) as ccy`, sql`o.date`)
  const rates = presentationSpotRatesSql(orgId, currency, sql`
    select coalesce(func, ${currency}) as ccy from closing_raw
    union select coalesce(func, ${currency}) from opening_raw
    union select coalesce(func, ${currency}) from cash_raw
    union select credit_currency from credit_raw where credit_limit is not null`, asOf)
  const translated = (amount: SQL, functional: SQL) => presentationAmountSql(amount, functional, currency, sql`r.rate::numeric`)
  return { cfg, isCurrent, source: sql`
    closing_raw as materialized (${closing}), opening_raw as materialized (${opening}),
    cash_raw as materialized (
      select x.id, x.to_line_id as line_id, target.party_id, x.applied_on::date as paid_on,
             target.due_date, x.amount, sub.base_currency as func,
             x.applied_on >= ${recentFrom}::date as is_recent,
             x.applied_on >= ${baselineFrom}::date as is_behavior,
             (x.applied_on::date - target.due_date::date) as late_days
      from applications x
      join journal_lines target on target.id = x.to_line_id and target.org_id = x.org_id
      join accounts a on a.id = target.account_id and a.org_id = target.org_id and a.type = 'asset_receivable'
      join journal_entries te on te.id = target.entry_id and te.org_id = target.org_id and te.book_id = ${bookId}
      join documents invoice on invoice.id = te.source_document_id and invoice.org_id = te.org_id and invoice.kind = 'customer_invoice'
      join journal_lines receipt on receipt.id = x.from_line_id and receipt.org_id = x.org_id
      join journal_entries re on re.id = receipt.entry_id and re.org_id = receipt.org_id and re.book_id = ${bookId}
      join documents payment on payment.id = re.source_document_id and payment.org_id = re.org_id and payment.kind = 'customer_payment'
      left join subsidiaries sub on sub.id = target.subsidiary_id and sub.org_id = target.org_id
      where x.org_id = ${orgId} and x.applied_on >= ${historyFrom}::date and x.applied_on <= ${asOf}::date
        and (x.unapplied_at is null or x.unapplied_at::date > ${asOf}::date)
        and te.status in ('posted', 'reversed') and re.status in ('posted', 'reversed')
        and te.reverses_entry_id is null and re.reverses_entry_id is null
        and te.posting_date <= ${asOf}::date and re.posting_date <= ${asOf}::date
        and not exists (select 1 from journal_entries rev where rev.org_id = ${orgId} and rev.reverses_entry_id in (te.id, re.id) and rev.posting_date <= ${asOf}::date)
        ${scoped(sql`target.subsidiary_id`)} ${scoped(sql`receipt.subsidiary_id`)}
    ),
    credit_raw as (
      select cr.party_id, cr.credit_limit, coalesce(cr.currency, ${currency}) as credit_currency,
             cr.is_on_hold as held, cr.hold_reason
      from customer_roles cr join parties p on p.id = cr.party_id and p.org_id = cr.org_id
      where cr.org_id = ${orgId} and ${isCurrent}
        and exists (select 1 from closing_raw c where c.party_id = cr.party_id)
        ${scope === null ? sql`` : sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${[...scope].sort().join(',')}}`}::uuid[]))`}
    ), unbilled_raw as materialized (
      select o.* from (${orderSource}) o where ${isCurrent}
        and exists (select 1 from credit_raw c where c.party_id = o.party_id)
    ), unbilled as materialized (
      select o.*, ${translated(sql`o.amount::numeric`, sql`coalesce(o.func, ${currency})`)} as value,
             coalesce(o.func, ${currency}) <> ${currency} and (r.rate is null or r.rate::numeric <= 0) as missing_rate
      from unbilled_raw o left join lateral (${orderRates}) r on true
    ), orders as (select party_id, sum(value) as value from unbilled group by party_id), rates as (${rates}),
    closing as materialized (
      select c.*, ${translated(sql`c.remaining`, sql`coalesce(c.func, ${currency})`)} as amount,
             greatest(${asOf}::date - c.due_date::date, 0) as late_days
      from closing_raw c left join rates r on r.from_currency = coalesce(c.func, ${currency})
    ),
    opening as materialized (
      select c.*, ${translated(sql`c.remaining`, sql`coalesce(c.func, ${currency})`)} as amount,
             case when ${from}::date - c.due_date::date <= 30 then 0 when ${from}::date - c.due_date::date <= 60 then 1 when ${from}::date - c.due_date::date < 90 then 2 else 3 end as cohort
      from opening_raw c left join rates r on r.from_currency = coalesce(c.func, ${currency})
      where c.remaining > 0 and c.due_date < ${from}::date
    ),
    cash as materialized (
      select c.*, ${translated(sql`c.amount`, sql`coalesce(c.func, ${currency})`)} as value
      from cash_raw c left join rates r on r.from_currency = coalesce(c.func, ${currency})
    ), credit as (
      select c.*, ${translated(sql`c.credit_limit`, sql`c.credit_currency`)} as limit_amount
      from credit_raw c left join rates r on r.from_currency = c.credit_currency
    ),
    notices as materialized (
      select dl.document_id, dl.status, dl.sent_at
      from dunning_log dl where dl.org_id = ${orgId}
        and exists (select 1 from closing c where c.doc_id = dl.document_id)
        and ((dl.status = 'sent' and dl.sent_at::date between ${addCalendarDays(asOf, 1 - cfg.reminderDays)}::date and ${asOf}::date)
          or (${isCurrent} and dl.status in ('failed', 'suppressed', 'staged') and dl.updated_at::date between ${addCalendarDays(asOf, 1 - cfg.reminderDays)}::date and ${asOf}::date))
    ), document_notices as (
      select document_id, bool_or(status = 'sent') as delivered,
             bool_or(status = 'failed') as failed, bool_or(status = 'suppressed') as suppressed, bool_or(status = 'staged') as queued,
             max(sent_at)::date as last_notice from notices group by document_id
    ), exposure as (
      select c.party_id, max(c.party_name) as name, sum(greatest(c.amount, 0)) as gross,
             sum(greatest(-c.amount, 0)) as credits, sum(c.amount) as net,
             coalesce(sum(greatest(c.amount, 0)) filter (where c.due_date < ${asOf}::date), 0) as overdue,
             coalesce(sum(greatest(c.amount, 0)) filter (where c.due_date <= ${addCalendarDays(asOf, -cfg.severeDays)}::date), 0) as severe,
             count(distinct c.doc_id)::int as documents,
             count(distinct c.doc_id) filter (where c.amount > 0 and c.due_date < ${asOf}::date)::int as overdue_documents,
             coalesce(max(c.late_days) filter (where c.amount > 0 and c.due_date is not null), 0)::int as oldest_days,
             coalesce(sum(greatest(c.amount, 0)) filter (where c.due_date is null), 0) as missing_terms,
             count(distinct c.doc_id) filter (where n.delivered and c.amount > 0 and c.due_date < ${asOf}::date)::int as delivered,
             count(distinct c.doc_id) filter (where n.failed and not n.delivered and c.amount > 0)::int as failed,
             count(distinct c.doc_id) filter (where n.suppressed and not n.delivered and c.amount > 0)::int as suppressed,
             max(n.last_notice) as last_notice,
             coalesce(sum(greatest(c.amount, 0)) filter (where (n.failed or n.suppressed) and not n.delivered and c.due_date < ${asOf}::date), 0) as failed_exposure
      from closing c left join document_notices n on n.document_id = c.doc_id group by c.party_id
    ), payment_behavior as (
      select party_id,
             count(distinct line_id) filter (where paid_on >= ${recentFrom}::date and due_date is not null)::int as observations,
             count(distinct line_id) filter (where paid_on < ${recentFrom}::date and paid_on >= ${baselineFrom}::date and due_date is not null)::int as baseline_observations,
             sum(value * late_days) filter (where paid_on >= ${recentFrom}::date and due_date is not null) / nullif(sum(value) filter (where paid_on >= ${recentFrom}::date and due_date is not null), 0) as recent_days,
             sum(value * late_days) filter (where paid_on < ${recentFrom}::date and paid_on >= ${baselineFrom}::date and due_date is not null) / nullif(sum(value) filter (where paid_on < ${recentFrom}::date and paid_on >= ${baselineFrom}::date and due_date is not null), 0) as baseline_days,
             coalesce(sum(value) filter (where paid_on >= ${recentFrom}::date and due_date is not null and late_days <= 0), 0) as on_time,
             coalesce(sum(value) filter (where paid_on >= ${recentFrom}::date and due_date is not null), 0) as eligible_cash
      from cash group by party_id
    ), customer_facts as materialized (
      select e.*, coalesce(b.observations, 0) as observations, coalesce(b.baseline_observations, 0) as baseline_observations,
             b.recent_days, b.baseline_days, b.recent_days - b.baseline_days as change_days,
             coalesce(b.on_time, 0) as on_time, coalesce(b.eligible_cash, 0) as eligible_cash,
             coalesce(b.observations >= ${cfg.minObservations} and b.baseline_observations >= ${cfg.minObservations} and b.recent_days - b.baseline_days >= ${cfg.deteriorationDays}, false) as deteriorating,
             cr.limit_amount, coalesce(orders.value, 0) as unbilled, e.net + coalesce(orders.value, 0) as committed,
             coalesce(cr.held, false) as held, cr.hold_reason
      from exposure e left join payment_behavior b on b.party_id = e.party_id
      left join credit cr on cr.party_id = e.party_id left join orders on orders.party_id = e.party_id
    ), period_cash as (
      select line_id, sum(value) as value from cash where paid_on >= ${from}::date group by line_id
    ), payment_months as materialized (
      select party_id, date_trunc('month', paid_on)::date::text as date,
             round(sum(value * late_days) / nullif(sum(value), 0), 1)::text as days
      from cash where due_date is not null and is_behavior group by 1, 2
    ), recoveries as materialized (
      select o.id, o.party_id, o.cohort, o.amount as opening,
             least(o.amount, coalesce(pc.value, 0)) as cash,
             greatest(coalesce(c.amount, 0), 0) as remaining
      from opening o left join period_cash pc on pc.line_id = o.id left join closing c on c.id = o.id
    ), missing as (
      select distinct ccy as currency, ${asOf}::date as date from (
        select coalesce(func, ${currency}) as ccy from closing_raw
        union select coalesce(func, ${currency}) from opening_raw where remaining > 0 and due_date < ${from}::date
        union select coalesce(func, ${currency}) from cash_raw
        union select credit_currency from credit_raw where credit_limit is not null
      ) cc left join rates r on r.from_currency = cc.ccy
      where cc.ccy <> ${currency} and (r.rate is null or r.rate::numeric <= 0)
      union select distinct coalesce(func, ${currency}), date::date from unbilled where missing_rate
    )` }
}

async function collectionSummary(source: SQL, currency: string, asOf: string): Promise<CollectionSummary> {
  const result = await analyticsQuery<Record<string, unknown> & { missing: string[] }>(sql`with ${source}
    select count(*) filter (where party_id is not null)::int as customers,
           count(*) filter (where party_id is not null and overdue > 0)::int as "overdueCustomers",
           count(*) filter (where party_id is not null and (deteriorating or severe > 0 or failed_exposure > 0))::int as "attentionCustomers",
           coalesce(sum(overdue) filter (where party_id is not null and (deteriorating or severe > 0 or failed_exposure > 0)), 0)::text as attention,
           coalesce(sum(overdue), 0)::text as overdue,
           count(*) filter (where deteriorating)::int as "deterioratingCustomers",
           coalesce(sum(overdue) filter (where deteriorating), 0)::text as "deterioratingExposure",
           (select (coalesce(sum(value) filter (where late_days <= 0), 0) / nullif(sum(value), 0))::text from cash where is_recent and due_date is not null) as "onTimeShare",
           (select count(distinct line_id)::int from cash where is_recent and due_date is not null) as observations,
           coalesce((select sum(opening) from recoveries), 0)::text as opening,
           coalesce((select sum(cash) from recoveries), 0)::text as recovered,
           coalesce((select sum(remaining) from recoveries), 0)::text as remaining,
           coalesce((select sum(opening - cash - remaining) from recoveries), 0)::text as "otherChange",
           coalesce(sum(failed_exposure), 0)::text as "failedExposure",
           coalesce(sum(delivered), 0)::int as "deliveredDocuments", coalesce(sum(overdue_documents), 0)::int as "overdueDocuments",
           coalesce(sum(missing_terms), 0)::text as "missingTerms", coalesce(sum(gross) filter (where party_id is null), 0)::text as unassigned,
           coalesce(sum(credits), 0)::text as credits,
           count(*) filter (where held)::int as "heldCustomers", coalesce(sum(greatest(committed, 0)) filter (where held), 0)::text as "heldExposure",
           count(*) filter (where limit_amount is not null)::int as "limitCustomers",
           count(*) filter (where limit_amount is not null and committed > limit_amount)::int as "overLimitCustomers",
           coalesce(sum(greatest(committed - limit_amount, 0)) filter (where limit_amount is not null), 0)::text as "overLimit",
           coalesce((select jsonb_agg(b order by index) from (
             select case when late_days <= 0 then 0 when late_days <= 7 then 1 when late_days <= 30 then 2 else 3 end as index,
                    sum(value)::text as amount, count(distinct line_id)::int as documents
             from cash where due_date is not null and is_recent group by 1) b), '[]'::jsonb) as behavior,
           coalesce((select jsonb_agg(n order by status) from (select status, count(*)::int as documents from (select case when delivered then 'sent' when failed then 'failed' when suppressed then 'suppressed' else 'staged' end as status from document_notices) outcomes group by status) n), '[]'::jsonb) as notices,
           coalesce((select jsonb_agg(currency order by currency) from (select distinct currency from missing) currencies), '[]'::jsonb) as missing, (select min(date)::text from missing) as "missingDate"
    from customer_facts`)
  const row = result.rows[0]!
  if (row.missing.length) throw new MissingExchangeRateError(row.missing[0]!, currency, String(row.missingDate ?? asOf), row.missing)
  for (const key of ['attention', 'overdue', 'deterioratingExposure', 'opening', 'recovered', 'remaining', 'otherChange', 'failedExposure', 'missingTerms', 'unassigned', 'credits', 'heldExposure', 'overLimit']) row[key] = normalizeMoney(String(row[key]))
  return { ...row, recoveryShare: receivablesRatio(String(row.recovered), String(row.opening)),
    coverageShare: receivablesRatio(String(row.deliveredDocuments), String(row.overdueDocuments)) } as unknown as CollectionSummary
}

/** Search and ranking execute against the complete authorized portfolio.
 * Only a page of customer evidence crosses the application boundary. */
async function customerPage(source: SQL, query: string, page: number, signal: string, creditOnly: boolean) {
  const filter = signal === 'deteriorating' ? sql`and deteriorating` : signal === 'severe' ? sql`and severe > 0`
    : signal === 'delivery' ? sql`and (failed > 0 or suppressed > 0)` : signal === 'terms' ? sql`and missing_terms > 0`
    : signal === 'held' ? sql`and held` : sql``
  const result = await analyticsQuery<{ customers: CollectionCustomer[]; total: number; page: number }>(sql`with ${source},
    filtered as (select * from customer_facts where true ${query ? sql`and position(lower(${query}) in lower(name)) > 0` : sql``} ${filter}
      ${creditOnly ? sql`and (held or (limit_amount is not null and committed > limit_amount))` : sql``}),
    counts as (select count(*)::int as total from filtered), selected as (
      select party_id as id, name, gross::text, credits::text, net::text, overdue::text, severe::text, documents,
             overdue_documents as "overdueDocuments", oldest_days as "oldestDays", missing_terms::text as "missingTerms",
             round(recent_days, 1)::text as "recentDays", round(baseline_days, 1)::text as "baselineDays", round(change_days, 1)::text as "changeDays",
             observations, baseline_observations as "baselineObservations", (on_time / nullif(eligible_cash, 0))::text as "onTimeShare", deteriorating,
             delivered, failed, suppressed, last_notice::text as "lastNotice", limit_amount::text as "creditLimit", committed::text, unbilled::text,
             case when limit_amount is null then null else greatest(limit_amount - committed, 0)::text end as headroom, held, hold_reason as "holdReason",
             coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'days', h.days) order by h.date) from payment_months h where h.party_id = filtered.party_id), '[]'::jsonb) as history
      from filtered order by deteriorating desc, severe desc, failed_exposure desc, overdue desc, gross desc, party_id nulls last
      limit ${PAGE_SIZE} offset (select (least(${page}, greatest(1, ceil(total::numeric / ${PAGE_SIZE})::int)) - 1) * ${PAGE_SIZE} from counts)
    ) select coalesce((select jsonb_agg(selected) from selected), '[]'::jsonb) as customers, (select total from counts) as total, (select least(${page}, greatest(1, ceil(total::numeric / ${PAGE_SIZE})::int)) from counts) as page`)
  const row = result.rows[0]!
  return { customers: row.customers.map(normalizeCustomer), total: row.total, page: row.page }
}

export async function receivablesIntelligenceData(orgId: string, from: string, asOf: string, scope: ReadonlySet<string> | null, filters: { customerQ?: string; customerPage?: string; signal?: string } = {}): Promise<ReceivablesIntelligence> {
  const currency = await presentationCurrency(orgId)
  const { source, cfg, isCurrent } = await collectionSource(orgId, from, asOf, scope, currency)
  const read = currentAnalyticsRead()
  const load = () => collectionSummary(source, currency, asOf)
  const summary = read?.slug === 'receivables-intelligence' && read.authz.user.orgId === orgId
    ? await cachedAnalyticsRead(read.authz, 'metric:collection-intelligence-v1', { from, asOf, cfg: JSON.stringify(cfg), scope: scope === null ? 'all' : [...scope].sort().join(',') }, load, { identity: read, admit: false }) : await load()
  const page = Math.max(1, Math.min(10000, Number.parseInt(filters.customerPage ?? '1', 10) || 1))
  const wantsCustomers = analyticsSection('receivables-intelligence', ['customers', 'behavior', 'collections', 'credit'])
  const wantsRecovery = analyticsSection('receivables-intelligence', ['recovery'])
  const wantsTrend = analyticsSection('receivables-intelligence', ['behavior', 'recovery', 'collections'])
  const [portfolio, recovery, trend] = await Promise.all([
    wantsCustomers ? customerPage(source, filters.customerQ?.trim().slice(0, 160) ?? '', page, filters.signal ?? '', read?.tab === 'credit') : Promise.resolve({ customers: [], total: 0, page: 1 }),
    wantsRecovery ? analyticsQuery<CollectionRecovery>(sql`with ${source} select cohort as index, sum(opening)::text as opening, sum(cash)::text as cash, sum(remaining)::text as remaining, sum(opening - cash - remaining)::text as other from recoveries group by cohort order by cohort`).then((r) => r.rows) : Promise.resolve([]),
    wantsTrend ? analyticsQuery<CollectionTrend>(sql`with ${source}
      select date_trunc('month', paid_on)::date::text as date, sum(value)::text as amount,
             round(sum(value * late_days) filter (where due_date is not null) / nullif(sum(value) filter (where due_date is not null), 0), 1)::text as days,
             count(distinct line_id)::int as documents from cash where paid_on >= ${from}::date group by 1 order by 1`).then((r) => r.rows) : Promise.resolve([]),
  ])
  return { from, asOf, currency, currentCredit: isCurrent, baselineDays: cfg.baselineDays, minObservations: cfg.minObservations,
    summary, customers: portfolio.customers, customerTotal: portfolio.total, customerPage: portfolio.page, recovery, trend }
}
