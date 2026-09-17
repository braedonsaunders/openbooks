import 'server-only'
import { sql } from 'drizzle-orm'
import { addCalendarDays, businessToday, weekStartsEndingOn } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { add, mulDecimal } from '@openbooks/engine/src/money.ts'
import { flowRates, lineFunctional, presentationCurrency, presentationRates, translateFlows } from '../fx-presentation'
import { openItems, parseISO, summariseSide, toISO } from '../cash/core'
import { isFeatureEnabled } from '../features'

/**
 * Purchasing module home — one light round trip for the buy-to-pay workspace
 * landing: commitments + payables vitals, the top vendor exposures (the hero
 * roster: open POs → open bills per vendor), a 13-week spend trend, and the
 * live-directory badges. The open-payables vitals reuse the shared cash
 * engine (openItems as of today) so the pulse ties to /ap by construction —
 * a bespoke live aggregate drifted on both time boundaries (F-t04-012).
 * The pay-run engine itself stays on the /ap cockpit tab.
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

export async function purchasingHome(
  orgId: string,
  subIds?: string[],
  /**
   * Server-set: the caller is unrestricted AND the viewed set contains the
   * org root, so document-side reads also match root-owned (null
   * subsidiary) rows. Restricted callers never receive it.
   */
  includeNullSubsidiary?: boolean,
): Promise<PurchasingHome> {
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
  // An explicitly empty scope is a caller whose visibility resolved to nothing
  // and must read no rows — never degrade to the whole organization. `[]`
  // binds as an empty uuid array so every `= any(...)` leg matches nothing.
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

  // Open-payables vitals reuse the shared cash engine as of today (F-t04-012):
  // the bespoke live aggregate counted future-posted bills while netting
  // future-dated applications, so the pulse never tied to /ap. openItems
  // arrives in presentation currency, exactly like the cockpit's summary.
  const [apItems, topRes, trendRes, badgeRes, paidRowsRes, spendRowsRes, poRowsRes, orgRes] = (await Promise.all([
    openItems(orgId, 'ap', today, subIds),
    // Hero roster — vendor commitments: open POs and open bills side by side.
    db.execute(sql`
      with oi as (
        select jl.party_id, jl.due_date, sub.base_currency as func,
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
          left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
         where jl.org_id = ${orgId} and jl.is_open_item and a.type = 'liability_payable' and jl.amount < 0${lineScope}
      ), bills as (
        select party_id, func, sum(remaining) as billed_open,
               sum(remaining) filter (where due_date < ${today}) as overdue,
               count(*) filter (where remaining > 0) as open_bills,
               min(due_date) as oldest_due
          from oi where remaining > 0 group by party_id, func
      )
      select b.party_id, b.func,
             coalesce(p.display_name, 'Unspecified') as name,
             coalesce(b.open_bills, 0) as open_bills,
             coalesce(b.billed_open, 0) as billed_open,
             coalesce(b.overdue, 0) as overdue,
             b.oldest_due
        from bills b
        left join parties p on p.id = b.party_id and p.org_id = ${orgId}
    `),
    // 13-week billed-spend trend (posted vendor bills by week). Documents
    // translate txn→functional at their maintained rate; the second leg to
    // presentation happens per (week, functional) below.
    db.execute(sql`
      select (date_trunc('week', coalesce(d.document_date, d.posting_date)))::date as wk,
             sub.base_currency as func,
             max(coalesce(d.document_date, d.posting_date))::text as late,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as spend
        from documents d
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind = 'vendor_bill' and d.status = 'posted'
         and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${trendFrom}
       group by 1, 2
    `),
    // Directory badges + the remaining vitals (money scalars moved to the
    // per-(date, functional) row queries below so the second translation leg
    // can run in JS).
    db.execute(sql`
      select
        ${ordersOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'purchase_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as open_pos,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
          and d.status = 'posted' and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as payments_7d,
        ${expensesOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'expense_report'
          and d.status not in ('posted', 'closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as unposted_expenses,
        (select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id and vr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``}) as vendors
    `),
    // 7-day payment value per (date, functional) for presentation translation.
    db.execute(sql`
      select coalesce(d.document_date, d.posting_date)::text as dt, sub.base_currency as func,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as amt
        from documents d
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
         and d.status = 'posted' and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${ago7}
       group by 1, 2
    `),
    // 30-day billed spend per (date, functional) for presentation translation.
    db.execute(sql`
      select coalesce(d.document_date, d.posting_date)::text as dt, sub.base_currency as func,
             coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0) as amt
        from documents d
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind = 'vendor_bill'
         and d.status = 'posted' and d.voided_at is null${docScope}
         and coalesce(d.document_date, d.posting_date) >= ${ago30}
       group by 1, 2
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

  // Presentation: balances translate at the tile-date (closing) spot, flows at
  // their document-date spot. Missing coverage fails closed.
  const base = await presentationCurrency(orgId)
  const balRates = await presentationRates(
    orgId,
    base,
    [...topRes.rows.map((r) => (r.func ?? null) as string | null)],
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
    const spend = Number(mulDecimal(String(r.spend ?? 0), trendCtx.rateAt((r.func ?? null) as string | null, late)))
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + spend)
  }
  const paid7dValue = Number(await translateFlows(
    orgId,
    paidRowsRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.dt).slice(0, 10), amount: String(r.amt ?? 0) })),
  ))
  const spend30d = Number(await translateFlows(
    orgId,
    spendRowsRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.dt).slice(0, 10), amount: String(r.amt ?? 0) })),
  ))

  const orgCurrency = String(orgRes.rows[0]?.baseCurrency ?? '').trim().toUpperCase()
  if (!orgCurrency) throw new Error('organization currency is not configured')
  const po = await openPoValueInOrgCurrency(orgId, orgCurrency, today, poRowsRes.rows)

  // Hero roster — vendor commitments merged from open bills and translated
  // open POs, ranked by combined exposure like the query did before. Bill
  // legs translate per (party, functional) at the tile-date spot.
  type BillsRow = {
    party_id: string
    func: string | null
    name: string
    open_bills: string | number
    billed_open: string | number
    overdue: string | number
    oldest_due: string | null
  }
  const billedByParty = new Map<string, {
    name: string
    openBills: number
    billedOpen: number
    overdue: number
    oldestDue: string | null
  }>()
  for (const raw of topRes.rows) {
    const r = raw as BillsRow
    const partyId = String(r.party_id)
    const cur = billedByParty.get(partyId) ?? { name: String(r.name), openBills: 0, billedOpen: 0, overdue: 0, oldestDue: null as string | null }
    cur.openBills += Number(r.open_bills ?? 0)
    cur.billedOpen += trBal(r.billed_open, r.func)
    cur.overdue += trBal(r.overdue, r.func)
    const due = r.oldest_due ? String(r.oldest_due) : null
    if (due && (!cur.oldestDue || due < cur.oldestDue)) cur.oldestDue = due
    billedByParty.set(partyId, cur)
  }
  const topExposure = [...new Set([...billedByParty.keys(), ...po.byParty.keys()])]
    .map((partyId) => {
      const b = billedByParty.get(partyId)
      const p = po.byParty.get(partyId)
      return {
        partyId,
        name: String(b?.name ?? p?.name ?? 'Unspecified'),
        openPoValue: Number(p?.value ?? 0),
        openPos: p?.count ?? 0,
        openBills: Number(b?.openBills ?? 0),
        billedOpen: Number(b?.billedOpen ?? 0),
        overdue: Number(b?.overdue ?? 0),
        oldestDue: b?.oldestDue ?? null,
      }
    })
    .sort((x, y) => y.billedOpen + y.openPoValue - (x.billedOpen + x.openPoValue))
    .slice(0, 10)

  // Open-payables vitals straight off the shared summary, so the pulse ties
  // to /ap by construction: signed outstanding, overdue as outstanding
  // minus current (the cockpit's own definition), the 7-day window and the
  // open-line count over the same as-of item set.
  const apSummary = summariseSide(apItems, parseISO(today), '0.0000', 0)
  const apOutstanding = Number(apSummary.outstanding)
  const apCurrent = Number(apSummary.buckets.find((b) => b.label === 'Current')?.amount ?? 0)
  const apOverdue = apOutstanding > apCurrent ? apOutstanding - apCurrent : 0
  let openBills = 0
  let dueNext7 = 0
  for (const it of apItems) {
    const remaining = Number(it.remaining)
    if (!(remaining > 0)) continue
    openBills += 1
    const due = it.dueDate ? toISO(it.dueDate) : null
    if (due !== null && due >= today && due < in7) dueNext7 += remaining
  }
  const badge = badgeRes.rows[0] ?? {}
  return {
    apOutstanding,
    apOverdue,
    openBills,
    dueNext7,
    openPoValue: Number(po.total ?? 0),
    openPos: Number(badge.open_pos ?? 0),
    spend30d,
    topExposure,
    trend: weekStarts.map((weekStart) => ({ weekStart, spend: byWeek.get(weekStart) ?? 0 })),
    badges: {
      openPos: Number(badge.open_pos ?? 0),
      openBills,
      payments7d: Number(badge.payments_7d ?? 0),
      paid7dValue,
      unpostedExpenses: Number(badge.unposted_expenses ?? 0),
      vendors: Number(badge.vendors ?? 0),
    },
    ordersEnabled: ordersOn,
    expensesEnabled: expensesOn,
  }
}
