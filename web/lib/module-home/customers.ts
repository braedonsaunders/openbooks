import 'server-only'
import { sql } from 'drizzle-orm'
import {
  addCalendarDays, businessToday, calendarQuarterBounds, weekStartsEndingOn,
} from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { add, mulDecimal } from '@openbooks/engine/src/money/money.ts'
import { flowRates, lineFunctional, presentationCurrency, presentationRates, translateFlows } from '../fx-presentation'
import { calculateForecast, type ForecastRow } from '../crm'
import { crmOpportunityScope } from '../crm-scope'
import { isFeatureEnabled } from '../features'
import { paymentStats } from '../cash/core'

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
  /**
   * The ONE org DSO — the same settlement-weighted trailing mean the cash
   * cockpit, cashflow analytics, MCP cashflow tool, get_vitals, and customer
   * intelligence quote (45-day documented default with no settlements).
   */
  dso: number
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
  const q = calendarQuarterBounds(today)

  const [arRes, dsoStats, topRes, trendRes, badgeRes, collectedRowsRes, forecast, orgRes] = (await Promise.all([
    // Open receivables aggregate — the cash engine's openItems population,
    // aggregated (F-t02-008: one open-receivables definition — the as-of
    // book — across dashboard, workspace, hub and aging). Legs are stamped
    // in their line entity's functional: aggregate per functional and
    // translate to presentation below.
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date, sub.base_currency as func,
               (case when d.kind = 'customer_credit' then -1 else 1 end) * (abs(jl.amount) - coalesce((
                 select sum(x.amount) from applications x
                  where x.org_id = ${orgId}
                    and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                    and x.applied_on <= ${today}
                    and (x.unapplied_at is null or x.unapplied_at::date > ${today}::date)
               ), 0)) as remaining
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = ${orgId} and je.status = 'posted'
           and je.posting_date <= ${today}
          join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
          join documents d on d.id = je.source_document_id and d.org_id = ${orgId}
           and d.posted_entry_id = je.id and d.status = 'posted' and d.kind in ('customer_invoice', 'customer_credit')
          left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'asset_receivable'
           and ((d.kind = 'customer_credit' and jl.amount < 0) or (d.kind <> 'customer_credit' and jl.amount > 0))${lineScope}
      )
      select oi.func,
             coalesce(sum(remaining), 0) as outstanding,
             coalesce(sum(remaining) filter (where due_date < ${today}), 0) as overdue,
             count(*) filter (where remaining <> 0) as open_count,
             count(*) filter (where remaining <> 0 and due_date < ${today}) as overdue_count
        from oi where remaining <> 0 group by oi.func
    `),
    // Days-sales-outstanding is the ONE org DSO from the cash engine's
    // maintained settlement rollup — the same reader the cash cockpit,
    // cashflow analytics, MCP cashflow tool, get_vitals, and customer
    // intelligence quote — never a second local grain. The rollup scan keeps
    // this landing cheap; subsidiary scoping rides the engine's own rules.
    paymentStats("ar", today, subIds, orgId),
    // Hero roster — top relationships by open balance, with open-opp counts.
    // Per (party, functional): the translated ranking happens in JS below.
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date, sub.base_currency as func,
               (case when d.kind = 'customer_credit' then -1 else 1 end) * (abs(jl.amount) - coalesce((
                 select sum(x.amount) from applications x
                  where x.org_id = ${orgId}
                    and (x.to_line_id = jl.id or x.from_line_id = jl.id)
                    and x.applied_on <= ${today}
                    and (x.unapplied_at is null or x.unapplied_at::date > ${today}::date)
               ), 0)) as remaining
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = ${orgId} and je.status = 'posted'
           and je.posting_date <= ${today}
          join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
          join documents d on d.id = je.source_document_id and d.org_id = ${orgId}
           and d.posted_entry_id = je.id and d.status = 'posted' and d.kind in ('customer_invoice', 'customer_credit')
          left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'asset_receivable'
           and ((d.kind = 'customer_credit' and jl.amount < 0) or (d.kind <> 'customer_credit' and jl.amount > 0))${lineScope}
      )
      select oi.party_id, oi.func, coalesce(p.display_name, 'Unspecified') as name,
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
       where oi.remaining <> 0
       group by oi.party_id, oi.func, p.display_name${crmOn ? sql`, opp.n` : sql``}
    `),
    // 13-week collections trend (posted customer payments by week). `total`
    // is denominated in the document's transaction currency, so convert each
    // receipt with its posting FX rate (first leg) before adding unlike
    // currencies; the second leg to presentation runs per (week, functional)
    // below.
    db.execute(sql`
      select (date_trunc('week', coalesce(d.document_date, d.posting_date)))::date as wk,
             sub.base_currency as func,
             max(coalesce(d.document_date, d.posting_date))::text as late,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as collected
        from documents d
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind = 'customer_payment' and d.status = 'posted'
         and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${trendFrom}
       group by 1, 2
    `),
    // Directory badges — cheap counts for the workspace's other pages (the
    // collected-value scalar moved to the row query below for translation).
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
        (select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from customer_roles cr where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``}) as customers
    `),
    // 7-day collection value per (date, functional) for presentation translation.
    db.execute(sql`
      select coalesce(d.document_date, d.posting_date)::text as dt, sub.base_currency as func,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as amt
        from documents d
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind = 'customer_payment'
         and d.status = 'posted' and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${ago7}
       group by 1, 2
    `),
    crmOn ? calculateForecast({ orgId, periodStart: q.start, periodEnd: q.end, allowedSubsidiaryIds: subIds === undefined ? null : new Set(subIds) }) : Promise.resolve([]),
    db.execute<{ baseCurrency: string }>(sql`
      select base_currency as "baseCurrency" from orgs where id = ${orgId}
    `),
  ]))

  // Presentation: balances translate at the tile-date (closing) spot, flows at
  // their document-date spot. Missing coverage fails closed.
  const base = await presentationCurrency(orgId)
  const balRates = await presentationRates(
    orgId,
    base,
    [...arRes.rows.map((r) => (r.func ?? null) as string | null), ...topRes.rows.map((r) => (r.func ?? null) as string | null)],
    today,
  )
  const trBal = (amount: unknown, func: unknown): number =>
    Number(mulDecimal(String(amount ?? 0), balRates.get(lineFunctional(typeof func === "string" ? func : null, base))!))
  // Each week bucket translates at its latest document date, so the rate
  // lookup never runs ahead of the data it translates.
  const trendCtx = await flowRates(
    orgId,
    trendRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.late ?? r.wk).slice(0, 10) })),
  )
  const byWeek = new Map<string, number>()
  for (const r of trendRes.rows) {
    const wk = String(r.wk).slice(0, 10)
    const late = String(r.late ?? r.wk).slice(0, 10)
    const collected = Number(mulDecimal(String(r.collected ?? 0), trendCtx.rateAt((r.func ?? null) as string | null, late)))
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + collected)
  }
  const collected7d = Number(await translateFlows(
    orgId,
    collectedRowsRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.dt).slice(0, 10), amount: String(r.amt ?? 0) })),
  ))

  // Open-receivables vitals: per-functional balances summed in presentation.
  let arOutstanding = 0
  let arOverdue = 0
  let openInvoices = 0
  let overdueInvoices = 0
  for (const r of arRes.rows) {
    arOutstanding += trBal(r.outstanding, r.func)
    arOverdue += trBal(r.overdue, r.func)
    openInvoices += Number(r.open_count ?? 0)
    overdueInvoices += Number(r.overdue_count ?? 0)
  }

  // Hero roster: merge per-(party, functional) legs in presentation, then
  // rank — the translated top 10, not the raw-functional top 10.
  const byParty = new Map<string, {
    name: string
    open: number
    overdue: number
    openInvoices: number
    openOpportunities: number
    oldestDue: string | null
  }>()
  for (const r of topRes.rows) {
    const partyId = String(r.party_id)
    const cur = byParty.get(partyId) ?? {
      name: String(r.name), open: 0, overdue: 0, openInvoices: 0, openOpportunities: 0, oldestDue: null as string | null,
    }
    cur.open += trBal(r.open, r.func)
    cur.overdue += trBal(r.overdue, r.func)
    cur.openInvoices += Number(r.open_invoices ?? 0)
    cur.openOpportunities = Math.max(cur.openOpportunities, Number(r.open_opps ?? 0))
    const due = r.oldest_due ? String(r.oldest_due) : null
    if (due && (!cur.oldestDue || due < cur.oldestDue)) cur.oldestDue = due
    byParty.set(partyId, cur)
  }
  const topExposure = [...byParty.entries()]
    .map(([partyId, b]) => ({ partyId, ...b }))
    .sort((x, y) => y.open - x.open)
    .slice(0, 10)

  const badge = badgeRes.rows[0] ?? {}
  const orgCurrency = String(orgRes.rows[0]?.baseCurrency ?? '').trim().toUpperCase()
  if (!orgCurrency) throw new Error('organization currency is not configured')
  const pipeline = await pipelineInOrgCurrency(orgId, orgCurrency, today, forecast)

  return {
    arOutstanding,
    arOverdue,
    openInvoices,
    overdueInvoices,
    activeCustomers: Number(badge.customers ?? 0),
    dso: dsoStats.globalAvg,
    pipeline,
    topExposure,
    trend: weekStarts.map((weekStart) => ({ weekStart, collected: byWeek.get(weekStart) ?? 0 })),
    badges: {
      openOpportunities: Number(badge.open_opps ?? 0),
      openQuotes: Number(badge.open_quotes ?? 0),
      openSalesOrders: Number(badge.open_sos ?? 0),
      receipts7d: Number(badge.receipts_7d ?? 0),
      collected7d,
      customers: Number(badge.customers ?? 0),
    },
    ordersEnabled: ordersOn,
    crmEnabled: crmOn,
  }
}
