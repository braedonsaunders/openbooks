import 'server-only'
import { sql } from 'drizzle-orm'
import {
  addCalendarDays, businessToday, calendarQuarterBounds, weekStartsEndingOn,
} from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { add, mulDecimal } from '@openbooks/engine/src/money.ts'
import { calculateForecast, type ForecastRow } from '../crm'
import { crmOpportunityScope } from '../crm-scope'
import { isFeatureEnabled } from '../features'

/**
 * Customers module home — one light round trip for the relationship-to-cash
 * workspace landing: the receivables/relationship vitals, the top open
 * balances (the hero roster), a 13-week collections trend, and the
 * live-directory badges. Deliberately NOT arPosition() — the prediction
 * engine stays on the /ar cockpit tab; everything here is cheap counts and
 * sums.
 */

export interface CustomerExposureRow {
  partyId: string
  name: string
  open: number
  overdue: number
  openInvoices: number
  openOpportunities: number
  oldestDue: string | null
}

export interface CustomersHome {
  arOutstanding: number
  arOverdue: number
  openInvoices: number
  overdueInvoices: number
  activeCustomers: number
  /** Avg days invoice → applied payment over the trailing year (DSO-lite). */
  dsoLite: number | null
  pipeline: { total: number; weighted: number; closed: number }
  topExposure: CustomerExposureRow[]
  /** Weekly collections (posted customer payments), oldest → newest. */
  trend: { weekStart: string; collected: number }[]
  badges: {
    openOpportunities: number
    openQuotes: number
    openSalesOrders: number
    receipts7d: number
    collected7d: number
    customers: number
  }
  /** False when Orders is off — hide quote/SO vitals rather than show zeros. */
  ordersEnabled: boolean
  /** False when CRM is off — hide pipeline/opportunity vitals rather than show zeros. */
  crmEnabled: boolean
}

const TREND_WEEKS = 13

/**
 * Forecast rollups retain each opportunity's transaction currency. The
 * customer home has one organization-currency scalar, so translate every
 * currency at the latest dated spot rate before adding the rows.
 */
async function pipelineInOrgCurrency(
  orgId: string,
  orgCurrency: string,
  asOf: string,
  rows: readonly ForecastRow[],
): Promise<{ total: number; weighted: number; closed: number }> {
  const rates = new Map<string, string>()
  let total = '0.0000'
  let weighted = '0.0000'
  let closed = '0.0000'
  for (const row of rows) {
    const sourceCurrency = String(row.currency).trim().toUpperCase()
    if (!sourceCurrency || sourceCurrency === orgCurrency) {
      total = add(total, row.pipeline_amount ?? '0')
      weighted = add(weighted, row.weighted_amount ?? '0')
      closed = add(closed, row.closed_amount ?? '0')
      continue
    }
    let rate = rates.get(sourceCurrency)
    if (!rate) {
      const candidates = await db.execute<{ rate: string }>(sql`
        select rate::text from (
          select rate, as_of, 0 as priority
            from fx_rates
           where org_id = ${orgId} and from_currency = ${sourceCurrency}
             and to_currency = ${orgCurrency} and rate_type = 'spot'
             and as_of <= ${asOf}
          union all
          select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority
            from fx_rates
           where org_id = ${orgId} and from_currency = ${orgCurrency}
             and to_currency = ${sourceCurrency} and rate_type = 'spot'
             and as_of <= ${asOf}
        ) candidates
        order by as_of desc, priority asc
        limit 1
      `)
      rate = candidates.rows[0]?.rate
      if (!rate) throw new Error(`no spot rate for customer pipeline ${sourceCurrency}→${orgCurrency} on or before ${asOf}`)
      rates.set(sourceCurrency, rate)
    }
    total = add(total, mulDecimal(row.pipeline_amount ?? '0', rate))
    weighted = add(weighted, mulDecimal(row.weighted_amount ?? '0', rate))
    closed = add(closed, mulDecimal(row.closed_amount ?? '0', rate))
  }
  return { total: Number(total), weighted: Number(weighted), closed: Number(closed) }
}

export async function customersHome(
  orgId: string,
  subIds?: string[],
  /**
   * Server-set: the caller is unrestricted AND the viewed set contains the
   * org root, so document-side reads also match root-owned (null
   * subsidiary) rows. Restricted callers never receive it.
   */
  includeNullSubsidiary?: boolean,
): Promise<CustomersHome> {
  const [ordersOn, crmOn] = await Promise.all([
    isFeatureEnabled(orgId, 'orders'),
    isFeatureEnabled(orgId, 'crm'),
  ])
  const today = await businessToday(orgId)
  const ago7 = addCalendarDays(today, -7)
  const ago365 = addCalendarDays(today, -365)
  const weekStarts = weekStartsEndingOn(today, TREND_WEEKS)
  const trendFrom = weekStarts[0]!
  const subArr = subIds !== undefined ? sql`${`{${subIds.join(',')}}`}::uuid[]` : null
  const lineScope = subArr ? sql` and jl.subsidiary_id = any(${subArr})` : sql``
  // Document-side reads match root-owned rows only for unrestricted
  // root-covering views; the limb never widens an empty scope (see filters).
  const docScope =
    subArr && includeNullSubsidiary === true && (subIds?.length ?? 0) > 0
      ? sql` and (d.subsidiary_id is null or d.subsidiary_id = any(${subArr}))`
      : subArr
        ? sql` and d.subsidiary_id = any(${subArr})`
        : sql``
  const dsoScope = subArr ? sql` and bl.subsidiary_id = any(${subArr})` : sql``
  const q = calendarQuarterBounds(today)

  const [arRes, dsoRes, topRes, trendRes, badgeRes, forecast, orgRes] = (await Promise.all([
    // Open receivables aggregate — open customer-invoice items with remaining
    // balance (the same open-item shape the cash engine reads, aggregated).
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date,
               abs(jl.amount) - coalesce((
                 select sum(x.amount) from applications x
                  where x.org_id = ${orgId}
                    and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                    and x.unapplied_at is null
               ), 0) as remaining
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = ${orgId} and je.status = 'posted'
          join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
          join documents d on d.id = je.source_document_id and d.org_id = ${orgId}
           and d.posted_entry_id = je.id and d.status = 'posted' and d.kind = 'customer_invoice'
           and d.open_balance > 0
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'asset_receivable' and jl.amount > 0${lineScope}
      )
      select coalesce(sum(remaining), 0) as outstanding,
             coalesce(sum(remaining) filter (where due_date < ${today}), 0) as overdue,
             count(*) filter (where remaining > 0) as open_count,
             count(*) filter (where remaining > 0 and due_date < ${today}) as overdue_count
        from oi where remaining > 0
    `),
    // Days-sales-outstanding is its own query so it runs BESIDE the open-item
    // aggregate instead of after it — as a scalar subquery the two costs added
    // up inside one statement. Both dates come off the lines; reaching them
    // through each line's entry doubled the joins. Trailing 365 days: without
    // the upper bound a future-dated payment counts toward days-to-pay.
    db.execute(sql`
      select round(avg(pl.posting_date - bl.posting_date)) as dso
        from applications ap
        join journal_lines bl on bl.id = ap.to_line_id and bl.org_id = ${orgId}
        join journal_lines pl on pl.id = ap.from_line_id and pl.org_id = ${orgId}
        join accounts ba on ba.id = bl.account_id and ba.org_id = ${orgId}
       where ap.org_id = ${orgId}
         and ba.type = 'asset_receivable' and ap.unapplied_at is null
         and pl.posting_date >= ${ago365}
         and pl.posting_date <= ${today}${dsoScope}
    `),
    // Hero roster — top relationships by open balance, with open-opp counts.
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date,
               abs(jl.amount) - coalesce((
                 select sum(x.amount) from applications x
                  where x.org_id = ${orgId}
                    and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                    and x.unapplied_at is null
               ), 0) as remaining
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = ${orgId} and je.status = 'posted'
          join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
          join documents d on d.id = je.source_document_id and d.org_id = ${orgId}
           and d.posted_entry_id = je.id and d.status = 'posted' and d.kind = 'customer_invoice'
           and d.open_balance > 0
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'asset_receivable' and jl.amount > 0${lineScope}
      )
      select oi.party_id, coalesce(p.display_name, 'Unspecified') as name,
             sum(oi.remaining) as open,
             sum(oi.remaining) filter (where oi.due_date < ${today}) as overdue,
             count(*) as open_invoices,
             min(oi.due_date) as oldest_due,
             ${crmOn ? sql`coalesce(opp.n, 0)` : sql`0`} as open_opps
        from oi
        left join parties p on p.id = oi.party_id and p.org_id = ${orgId}
        ${crmOn ? sql`left join lateral (
          select count(*) as n
            from crm_opportunities o
            join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
           where o.org_id = ${orgId} ${crmOpportunityScope(subIds === undefined ? null : new Set(subIds))} and o.is_active and not s.is_closed
             and o.party_id = oi.party_id) opp on true` : sql``}
       where oi.remaining > 0
       group by oi.party_id, p.display_name${crmOn ? sql`, opp.n` : sql``}
       order by sum(oi.remaining) desc
       limit 10
    `),
    // 13-week collections trend (posted customer payments by week). `total`
    // is denominated in the document's transaction currency, so convert each
    // receipt with its posting FX rate before adding unlike currencies.
    db.execute(sql`
      select (date_trunc('week', coalesce(d.document_date, d.posting_date)))::date as wk,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as collected
        from documents d
       where d.org_id = ${orgId} and d.kind = 'customer_payment' and d.status = 'posted'
         and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${trendFrom}
       group by 1
    `),
    // Directory badges — cheap counts for the workspace's other pages.
    db.execute(sql`
      select
        ${crmOn ? sql`(select count(*) from crm_opportunities o join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
          where o.org_id = ${orgId} ${crmOpportunityScope(subIds === undefined ? null : new Set(subIds))} and o.is_active and not s.is_closed)` : sql`0`} as open_opps,
        ${ordersOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'quote'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as open_quotes,
        ${ordersOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'sales_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as open_sos,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'customer_payment'
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as receipts_7d,
        (select coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) from documents d where d.org_id = ${orgId} and d.kind = 'customer_payment'
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as collected_7d,
        (select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from customer_roles cr where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``}) as customers
    `),
    crmOn ? calculateForecast({ orgId, periodStart: q.start, periodEnd: q.end, allowedSubsidiaryIds: subIds === undefined ? null : new Set(subIds) }) : Promise.resolve([]),
    db.execute<{ baseCurrency: string }>(sql`
      select base_currency as "baseCurrency" from orgs where id = ${orgId}
    `),
  ]))

  const byWeek = new Map(trendRes.rows.map((r) => [String(r.wk).slice(0, 10), Number(r.collected)]))

  const ar = arRes.rows[0] ?? {}
  const dso = dsoRes.rows[0] ?? {}
  const badge = badgeRes.rows[0] ?? {}
  const orgCurrency = String(orgRes.rows[0]?.baseCurrency ?? '').trim().toUpperCase()
  if (!orgCurrency) throw new Error('organization currency is not configured')
  const pipeline = await pipelineInOrgCurrency(orgId, orgCurrency, today, forecast)

  return {
    arOutstanding: Number(ar.outstanding ?? 0),
    arOverdue: Number(ar.overdue ?? 0),
    openInvoices: Number(ar.open_count ?? 0),
    overdueInvoices: Number(ar.overdue_count ?? 0),
    activeCustomers: Number(badge.customers ?? 0),
    dsoLite: dso.dso === null || dso.dso === undefined ? null : Number(dso.dso),
    pipeline,
    topExposure: topRes.rows.map((r: any) => ({
      partyId: r.party_id,
      name: r.name,
      open: Number(r.open),
      overdue: Number(r.overdue ?? 0),
      openInvoices: Number(r.open_invoices),
      openOpportunities: Number(r.open_opps ?? 0),
      oldestDue: r.oldest_due ? String(r.oldest_due) : null,
    })),
    trend: weekStarts.map((weekStart) => ({ weekStart, collected: byWeek.get(weekStart) ?? 0 })),
    badges: {
      openOpportunities: Number(badge.open_opps ?? 0),
      openQuotes: Number(badge.open_quotes ?? 0),
      openSalesOrders: Number(badge.open_sos ?? 0),
      receipts7d: Number(badge.receipts_7d ?? 0),
      collected7d: Number(badge.collected_7d ?? 0),
      customers: Number(badge.customers ?? 0),
    },
    ordersEnabled: ordersOn,
    crmEnabled: crmOn,
  }
}
