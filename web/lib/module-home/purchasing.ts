import 'server-only'
import { sql } from 'drizzle-orm'
import { addCalendarDays, businessToday, weekStartsEndingOn } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { add, mulDecimal } from '@openbooks/engine/src/money.ts'
import { isFeatureEnabled } from '../features'

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
  /** False when Orders is off — hide PO vitals rather than show zeros. */
  ordersEnabled: boolean
  /** False when Expenses is off — hide unposted-expense vitals rather than show zeros. */
  expensesEnabled: boolean
}

const TREND_WEEKS = 13

type OpenPoRow = {
  party_id: string | null
  name: string | null
  total: string
  currency: string
}

/**
 * Open purchase-order commitments in organization currency. POs never post,
 * so they carry no maintained fx_rate — translate every order at the latest
 * dated spot rate before adding, exactly like the customer pipeline. A
 * missing rate fails closed: a silently dropped commitment is worse than a
 * loud one.
 */
async function openPoValueInOrgCurrency(
  orgId: string,
  orgCurrency: string,
  asOf: string,
  rows: readonly OpenPoRow[],
): Promise<{ byParty: Map<string, { name: string; value: string; count: number }>; total: string }> {
  const rates = new Map<string, string>()
  const byParty = new Map<string, { name: string; value: string; count: number }>()
  let total = '0.0000'
  for (const row of rows) {
    const sourceCurrency = String(row.currency ?? '').trim().toUpperCase()
    let converted = String(row.total ?? '0')
    if (sourceCurrency && sourceCurrency !== orgCurrency) {
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
        if (!rate) throw new Error(`no spot rate for open purchase orders ${sourceCurrency}→${orgCurrency} on or before ${asOf}`)
        rates.set(sourceCurrency, rate)
      }
      converted = mulDecimal(converted, rate)
    }
    total = add(total, converted)
    if (row.party_id) {
      const prior = byParty.get(row.party_id)
      byParty.set(row.party_id, {
        name: prior?.name ?? row.name ?? 'Unspecified',
        value: add(prior?.value ?? '0.0000', converted),
        count: (prior?.count ?? 0) + 1,
      })
    }
  }
  return { byParty, total }
}

export async function purchasingHome(orgId: string, subIds?: string[]): Promise<PurchasingHome> {
  const [ordersOn, expensesOn] = await Promise.all([
    isFeatureEnabled(orgId, 'orders'),
    isFeatureEnabled(orgId, 'expenses'),
  ])
  const today = await businessToday(orgId)
  const ago7 = addCalendarDays(today, -7)
  const ago30 = addCalendarDays(today, -30)
  const in7 = addCalendarDays(today, 7)
  const weekStarts = weekStartsEndingOn(today, TREND_WEEKS)
  const trendFrom = weekStarts[0]!
  const subArr = subIds && subIds.length > 0 ? sql`${`{${subIds.join(',')}}`}::uuid[]` : null
  const lineScope = subArr ? sql` and jl.subsidiary_id = any(${subArr})` : sql``
  const docScope = subArr ? sql` and (d.subsidiary_id is null or d.subsidiary_id = any(${subArr}))` : sql``

  const [apRes, topRes, trendRes, badgeRes, poRowsRes, orgRes] = (await Promise.all([
    // Open payables aggregate — open bill/expense items with remaining balance.
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
           and d.posted_entry_id = je.id and d.status = 'posted'
           and d.kind in ('vendor_bill', 'expense_report')
           and d.open_balance > 0
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'liability_payable' and jl.amount < 0${lineScope}
      )
      select coalesce(sum(remaining), 0) as outstanding,
             coalesce(sum(remaining) filter (where due_date < ${today}), 0) as overdue,
             coalesce(sum(remaining) filter (where due_date >= ${today} and due_date < ${in7}), 0) as due_7,
             count(*) filter (where remaining > 0) as open_count
        from oi where remaining > 0
    `),
    // Hero roster — vendor commitments: open POs and open bills side by side.
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
           and d.posted_entry_id = je.id and d.status = 'posted'
           and d.kind in ('vendor_bill', 'expense_report')
           and d.open_balance > 0
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'liability_payable' and jl.amount < 0${lineScope}
      ), bills as (
        select party_id, sum(remaining) as billed_open,
               sum(remaining) filter (where due_date < ${today}) as overdue,
               count(*) filter (where remaining > 0) as open_bills,
               min(due_date) as oldest_due
          from oi where remaining > 0 group by party_id
      )
      select b.party_id,
             coalesce(p.display_name, 'Unspecified') as name,
             coalesce(b.open_bills, 0) as open_bills,
             coalesce(b.billed_open, 0) as billed_open,
             coalesce(b.overdue, 0) as overdue,
             b.oldest_due
        from bills b
        left join parties p on p.id = b.party_id and p.org_id = ${orgId}
    `),
    // 13-week billed-spend trend (posted vendor bills by week).
    db.execute(sql`
      select (date_trunc('week', coalesce(d.document_date, d.posting_date)))::date as wk,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as spend
        from documents d
       where d.org_id = ${orgId} and d.kind = 'vendor_bill' and d.status = 'posted'
         and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${trendFrom}
       group by 1
    `),
    // Directory badges + the remaining vitals.
    db.execute(sql`
      select
        ${ordersOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'purchase_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as open_pos,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as payments_7d,
        (select coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) from documents d where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as paid_7d_value,
        ${expensesOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'expense_report'
          and d.status not in ('posted', 'closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as unposted_expenses,
        (select coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) from documents d where d.org_id = ${orgId} and d.kind = 'vendor_bill'
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago30}) as spend_30d,
        (select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id and vr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``}) as vendors
    `),
    // Open purchase-order headers translate per-row in JS: POs never post,
    // so they carry no maintained fx_rate and a SQL sum would mix
    // transaction currencies.
    ordersOn
      ? db.execute<OpenPoRow>(sql`
        select d.party_id, coalesce(p.display_name, 'Unspecified') as name,
               abs(d.total) as total, d.currency
          from documents d
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = 'purchase_order'
           and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope}`)
      : Promise.resolve({ rows: [] as OpenPoRow[] }),
    db.execute<{ baseCurrency: string }>(sql`
      select base_currency as "baseCurrency" from orgs where id = ${orgId}`),
  ]))

  const byWeek = new Map(trendRes.rows.map((r) => [String(r.wk).slice(0, 10), Number(r.spend)]))

  const orgCurrency = String(orgRes.rows[0]?.baseCurrency ?? '').trim().toUpperCase()
  if (!orgCurrency) throw new Error('organization currency is not configured')
  const po = await openPoValueInOrgCurrency(orgId, orgCurrency, today, poRowsRes.rows)

  // Hero roster — vendor commitments merged from open bills and translated
  // open POs, ranked by combined exposure like the query did before.
  type BillsRow = {
    party_id: string
    name: string
    open_bills: string | number
    billed_open: string | number
    overdue: string | number
    oldest_due: string | null
  }
  const billedByParty = new Map(
    topRes.rows.map((r) => [String((r as BillsRow).party_id), r as BillsRow]),
  )
  const topExposure = [...new Set([...billedByParty.keys(), ...po.byParty.keys()])]
    .map((partyId) => {
      const b = billedByParty.get(partyId)
      const p = po.byParty.get(partyId)
      return {
        partyId,
        name: String(b?.name ?? p?.name ?? 'Unspecified'),
        openPoValue: Number(p?.value ?? 0),
        openPos: p?.count ?? 0,
        openBills: Number(b?.open_bills ?? 0),
        billedOpen: Number(b?.billed_open ?? 0),
        overdue: Number(b?.overdue ?? 0),
        oldestDue: b?.oldest_due ? String(b.oldest_due) : null,
      }
    })
    .sort((x, y) => y.billedOpen + y.openPoValue - (x.billedOpen + x.openPoValue))
    .slice(0, 10)

  const ap = apRes.rows[0] ?? {}
  const badge = badgeRes.rows[0] ?? {}
  return {
    apOutstanding: Number(ap.outstanding ?? 0),
    apOverdue: Number(ap.overdue ?? 0),
    openBills: Number(ap.open_count ?? 0),
    dueNext7: Number(ap.due_7 ?? 0),
    openPoValue: Number(po.total ?? 0),
    openPos: Number(badge.open_pos ?? 0),
    spend30d: Number(badge.spend_30d ?? 0),
    topExposure,
    trend: weekStarts.map((weekStart) => ({ weekStart, spend: byWeek.get(weekStart) ?? 0 })),
    badges: {
      openPos: Number(badge.open_pos ?? 0),
      openBills: Number(ap.open_count ?? 0),
      payments7d: Number(badge.payments_7d ?? 0),
      paid7dValue: Number(badge.paid_7d_value ?? 0),
      unpostedExpenses: Number(badge.unposted_expenses ?? 0),
      vendors: Number(badge.vendors ?? 0),
    },
    ordersEnabled: ordersOn,
    expensesEnabled: expensesOn,
  }
}
