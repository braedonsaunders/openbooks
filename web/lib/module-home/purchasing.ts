import 'server-only'
import { sql } from 'drizzle-orm'
import { addCalendarDays, businessToday, weekStartsEndingOn } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Purchasing module home — one light round trip for the buy-to-pay workspace
 * landing: commitments + payables vitals, the top vendor exposures (the hero
 * roster: open POs → open bills per vendor), a 13-week spend trend, and the
 * live-directory badges. Deliberately NOT apPosition() — the pay-run engine
 * stays on the /ap cockpit tab; everything here is cheap counts and sums.
 */

export interface VendorExposureRow {
  partyId: string
  name: string
  openPoValue: number
  openPos: number
  openBills: number
  billedOpen: number
  overdue: number
  oldestDue: string | null
}

export interface PurchasingHome {
  apOutstanding: number
  apOverdue: number
  openBills: number
  dueNext7: number
  openPoValue: number
  openPos: number
  spend30d: number
  topExposure: VendorExposureRow[]
  /** Weekly billed spend (posted vendor bills), oldest → newest. */
  trend: { weekStart: string; spend: number }[]
  badges: {
    openPos: number
    openBills: number
    payments7d: number
    paid7dValue: number
    unpostedExpenses: number
    vendors: number
  }
}

const TREND_WEEKS = 13

export async function purchasingHome(orgId: string, subIds?: string[]): Promise<PurchasingHome> {
  const today = await businessToday(orgId)
  const ago7 = addCalendarDays(today, -7)
  const ago30 = addCalendarDays(today, -30)
  const in7 = addCalendarDays(today, 7)
  const weekStarts = weekStartsEndingOn(today, TREND_WEEKS)
  const trendFrom = weekStarts[0]!
  const subArr = subIds && subIds.length > 0 ? sql`${`{${subIds.join(',')}}`}::uuid[]` : null
  const lineScope = subArr ? sql` and jl.subsidiary_id = any(${subArr})` : sql``
  const docScope = subArr ? sql` and (d.subsidiary_id is null or d.subsidiary_id = any(${subArr}))` : sql``

  const [apRes, topRes, trendRes, badgeRes] = (await Promise.all([
    // Open payables aggregate — open bill/expense items with remaining balance.
    db.execute<any>(sql`
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
           and d.posted_entry_id = je.id and d.status = 'posted'
           and d.kind in ('vendor_bill', 'expense_report')
           and d.open_balance > 0.005
         where jl.is_open_item and a.type = 'liability_payable' and jl.amount < 0${lineScope}
      )
      select coalesce(sum(remaining), 0) as outstanding,
             coalesce(sum(remaining) filter (where due_date < ${today}), 0) as overdue,
             coalesce(sum(remaining) filter (where due_date >= ${today} and due_date < ${in7}), 0) as due_7,
             count(*) filter (where remaining > 0.005) as open_count
        from oi where remaining > 0.005
    `),
    // Hero roster — vendor commitments: open POs and open bills side by side.
    db.execute<any>(sql`
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
           and d.posted_entry_id = je.id and d.status = 'posted'
           and d.kind in ('vendor_bill', 'expense_report')
           and d.open_balance > 0.005
         where jl.is_open_item and a.type = 'liability_payable' and jl.amount < 0${lineScope}
      ), bills as (
        select party_id, sum(remaining) as billed_open,
               sum(remaining) filter (where due_date < ${today}) as overdue,
               count(*) filter (where remaining > 0.005) as open_bills,
               min(due_date) as oldest_due
          from oi where remaining > 0.005 group by party_id
      ), pos as (
        select d.party_id, coalesce(sum(abs(d.total)), 0) as po_value, count(*) as n
          from documents d
         where d.org_id = ${orgId} and d.kind = 'purchase_order'
           and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope}
         group by d.party_id
      )
      select coalesce(b.party_id, po.party_id) as party_id,
             coalesce(p.display_name, 'Unspecified') as name,
             coalesce(po.po_value, 0) as open_po_value,
             coalesce(po.n, 0) as open_pos,
             coalesce(b.open_bills, 0) as open_bills,
             coalesce(b.billed_open, 0) as billed_open,
             coalesce(b.overdue, 0) as overdue,
             b.oldest_due
        from bills b
        full outer join pos po on po.party_id = b.party_id
        left join parties p on p.id = coalesce(b.party_id, po.party_id)
       order by coalesce(b.billed_open, 0) + coalesce(po.po_value, 0) desc
       limit 10
    `),
    // 13-week billed-spend trend (posted vendor bills by week).
    db.execute<any>(sql`
      select (date_trunc('week', coalesce(d.document_date, d.posting_date)))::date as wk,
             coalesce(sum(abs(d.total)), 0) as spend
        from documents d
       where d.org_id = ${orgId} and d.kind = 'vendor_bill' and d.status = 'posted'
         and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${trendFrom}
       group by 1
    `),
    // Directory badges + the remaining vitals.
    db.execute<any>(sql`
      select
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'purchase_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope}) as open_pos,
        (select coalesce(sum(abs(d.total)), 0) from documents d where d.org_id = ${orgId} and d.kind = 'purchase_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope}) as open_po_value,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as payments_7d,
        (select coalesce(sum(abs(d.total)), 0) from documents d where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as paid_7d_value,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'expense_report'
          and d.status not in ('posted', 'closed', 'cancelled') and d.voided_at is null${docScope}) as unposted_expenses,
        (select coalesce(sum(abs(d.total)), 0) from documents d where d.org_id = ${orgId} and d.kind = 'vendor_bill'
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago30}) as spend_30d,
        (select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from vendor_roles vr where vr.org_id = ${orgId} and vr.party_id = p.id and vr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``}) as vendors
    `),
  ]))

  const byWeek = new Map(trendRes.rows.map((r: any) => [String(r.wk).slice(0, 10), Number(r.spend)]))

  const ap = apRes.rows[0] ?? {}
  const badge = badgeRes.rows[0] ?? {}
  return {
    apOutstanding: Number(ap.outstanding ?? 0),
    apOverdue: Number(ap.overdue ?? 0),
    openBills: Number(ap.open_count ?? 0),
    dueNext7: Number(ap.due_7 ?? 0),
    openPoValue: Number(badge.open_po_value ?? 0),
    openPos: Number(badge.open_pos ?? 0),
    spend30d: Number(badge.spend_30d ?? 0),
    topExposure: topRes.rows.map((r: any) => ({
      partyId: r.party_id,
      name: r.name,
      openPoValue: Number(r.open_po_value ?? 0),
      openPos: Number(r.open_pos ?? 0),
      openBills: Number(r.open_bills ?? 0),
      billedOpen: Number(r.billed_open ?? 0),
      overdue: Number(r.overdue ?? 0),
      oldestDue: r.oldest_due ? String(r.oldest_due) : null,
    })),
    trend: weekStarts.map((weekStart) => ({ weekStart, spend: byWeek.get(weekStart) ?? 0 })),
    badges: {
      openPos: Number(badge.open_pos ?? 0),
      openBills: Number(ap.open_count ?? 0),
      payments7d: Number(badge.payments_7d ?? 0),
      paid7dValue: Number(badge.paid_7d_value ?? 0),
      unpostedExpenses: Number(badge.unposted_expenses ?? 0),
      vendors: Number(badge.vendors ?? 0),
    },
  }
}
