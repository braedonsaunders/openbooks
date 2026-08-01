import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { calculateForecast } from '../crm'

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
}

const TREND_WEEKS = 13

/** Quarter bounds for the pipeline vitals (calendar quarter of today). */
function quarterBounds(): { start: string; end: string } {
  const now = new Date()
  const q = Math.floor(now.getUTCMonth() / 3)
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

export async function customersHome(orgId: string, subIds?: string[]): Promise<CustomersHome> {
  const subArr = subIds && subIds.length > 0 ? sql`${`{${subIds.join(',')}}`}::uuid[]` : null
  const lineScope = subArr ? sql` and jl.subsidiary_id = any(${subArr})` : sql``
  const docScope = subArr ? sql` and (d.subsidiary_id is null or d.subsidiary_id = any(${subArr}))` : sql``
  const q = quarterBounds()

  const [arRes, topRes, trendRes, badgeRes, forecast] = (await Promise.all([
    // Open receivables aggregate — open customer-invoice items with remaining
    // balance (the same open-item shape the cash engine reads, aggregated).
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date,
               abs(jl.amount) - coalesce((
                 select sum(x.amount) from applications x
                  where (x.to_line_id = jl.id or x.from_line_id = jl.id) and x.unapplied_at is null
               ), 0) as remaining
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
          join accounts a on a.id = jl.account_id
          join documents d on d.id = je.source_document_id and d.kind = 'customer_invoice'
         where jl.is_open_item and a.type = 'asset_receivable' and jl.amount > 0${lineScope}
      )
      select coalesce(sum(remaining), 0) as outstanding,
             coalesce(sum(remaining) filter (where due_date < current_date), 0) as overdue,
             count(*) filter (where remaining > 0.005) as open_count,
             count(*) filter (where remaining > 0.005 and due_date < current_date) as overdue_count,
             (select round(avg(pe.posting_date - be.posting_date))
                from applications ap
                join journal_lines bl on bl.id = ap.to_line_id
                join journal_entries be on be.id = bl.entry_id
                join journal_lines pl on pl.id = ap.from_line_id
                join journal_entries pe on pe.id = pl.entry_id
                join accounts ba on ba.id = bl.account_id
               where ba.type = 'asset_receivable' and ap.unapplied_at is null
                 and bl.org_id = ${orgId}
                 and pe.posting_date >= current_date - 365) as dso
        from oi where remaining > 0.005
    `),
    // Hero roster — top relationships by open balance, with open-opp counts.
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date,
               abs(jl.amount) - coalesce((
                 select sum(x.amount) from applications x
                  where (x.to_line_id = jl.id or x.from_line_id = jl.id) and x.unapplied_at is null
               ), 0) as remaining
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
          join accounts a on a.id = jl.account_id
          join documents d on d.id = je.source_document_id and d.kind = 'customer_invoice'
         where jl.is_open_item and a.type = 'asset_receivable' and jl.amount > 0${lineScope}
      )
      select oi.party_id, coalesce(p.display_name, 'Unspecified') as name,
             sum(oi.remaining) as open,
             sum(oi.remaining) filter (where oi.due_date < current_date) as overdue,
             count(*) as open_invoices,
             min(oi.due_date) as oldest_due,
             coalesce(opp.n, 0) as open_opps
        from oi
        left join parties p on p.id = oi.party_id
        left join lateral (
          select count(*) as n
            from crm_opportunities o
            join crm_opportunity_statuses s on s.id = o.status_id
           where o.org_id = ${orgId} and o.is_active and not s.is_closed
             and o.party_id = oi.party_id) opp on true
       where oi.remaining > 0.005
       group by oi.party_id, p.display_name, opp.n
       order by sum(oi.remaining) desc
       limit 10
    `),
    // 13-week collections trend (posted customer payments by week).
    db.execute(sql`
      select (date_trunc('week', coalesce(d.document_date, d.posting_date)))::date as wk,
             coalesce(sum(abs(d.total)), 0) as collected
        from documents d
       where d.org_id = ${orgId} and d.kind = 'customer_payment' and d.status = 'posted'
         and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= (date_trunc('week', current_date) - interval '${sql.raw(String(TREND_WEEKS - 1))} weeks')
       group by 1
    `),
    // Directory badges — cheap counts for the workspace's other pages.
    db.execute(sql`
      select
        (select count(*) from crm_opportunities o join crm_opportunity_statuses s on s.id = o.status_id
          where o.org_id = ${orgId} and o.is_active and not s.is_closed) as open_opps,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'quote'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope}) as open_quotes,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'sales_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope}) as open_sos,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'customer_payment'
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= current_date - 7) as receipts_7d,
        (select coalesce(sum(abs(d.total)), 0) from documents d where d.org_id = ${orgId} and d.kind = 'customer_payment'
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= current_date - 7) as collected_7d,
        (select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from customer_roles cr where cr.org_id = ${orgId} and cr.party_id = p.id and cr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``}) as customers
    `),
    calculateForecast({ orgId, periodStart: q.start, periodEnd: q.end }),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }, { rows: any[] }, Record<string, string>[]]

  const weekStarts: string[] = []
  {
    const now = new Date()
    const day = (now.getUTCDay() + 6) % 7
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day))
    for (let i = TREND_WEEKS - 1; i >= 0; i--) {
      const d = new Date(monday)
      d.setUTCDate(monday.getUTCDate() - i * 7)
      weekStarts.push(d.toISOString().slice(0, 10))
    }
  }
  const byWeek = new Map(trendRes.rows.map((r: any) => [String(r.wk).slice(0, 10), Number(r.collected)]))

  const ar = arRes.rows[0] ?? {}
  const badge = badgeRes.rows[0] ?? {}
  // Multi-currency orgs: the vitals sum the per-currency figures (same
  // simplification the banking home makes for balances).
  const pipeline = forecast.reduce(
    (acc, r) => ({
      total: acc.total + Number(r.pipeline_amount ?? 0),
      weighted: acc.weighted + Number(r.weighted_amount ?? 0),
      closed: acc.closed + Number(r.closed_amount ?? 0),
    }),
    { total: 0, weighted: 0, closed: 0 },
  )

  return {
    arOutstanding: Number(ar.outstanding ?? 0),
    arOverdue: Number(ar.overdue ?? 0),
    openInvoices: Number(ar.open_count ?? 0),
    overdueInvoices: Number(ar.overdue_count ?? 0),
    activeCustomers: Number(badge.customers ?? 0),
    dsoLite: ar.dso === null || ar.dso === undefined ? null : Number(ar.dso),
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
  }
}
