import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { addCalendarDays, businessToday, weekStartsEndingOn } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { add, cmp, mulDecimal } from '@openbooks/engine/src/money/money.ts'
import { agingBasisDate } from '../aging-basis'
import { flowRates, translateFlows } from '../fx-presentation'
import { openItems, parseISO, summariseSide, toISO } from '../cash/core'
import { isFeatureEnabled } from '../features'

/**
 * Purchasing module home — one light round trip for the buy-to-pay workspace
 * landing: commitments + payables vitals, the top vendor exposures (the hero
 * roster: open POs → open bills per vendor), a 13-week spend trend, and the
 * live-directory badges. The open-payables vitals reuse the shared cash
 * engine (openItems as of today) so the pulse ties to /ap by construction —
 * a bespoke live aggregate drifted on both time boundaries.
 * The pay-run engine itself stays on the /ap cockpit tab.
 */

export interface VendorExposureRow {
  partyId: string
  name: string
  openPoValue: string
  openPos: number
  openBills: number
  billedOpen: string
  overdue: string
  oldestDue: string | null
}

export interface PurchasingHome {
  apOutstanding: string
  apOverdue: string
  openBills: number
  dueNext7: string
  openPoValue: string
  openPos: number
  /** Exact decimal string, never a float — the cockpit formats it, the chart converts at its boundary. */
  spend30d: string
  topExposure: VendorExposureRow[]
  /** Weekly billed spend (posted vendor bills) as exact decimal strings, oldest → newest. */
  trend: { weekStart: string; spend: string }[]
  badges: {
    openPos: number
    openBills: number
    payments7d: number
    /** Exact decimal string, never a float. */
    paid7dValue: string
    unpostedExpenses: number
    vendors: number
  }
  /** False when Orders is off — hide PO vitals rather than show zeros. */
  ordersEnabled: boolean
  /** False when Expenses is off — hide unposted-expense vitals rather than show zeros. */
  expensesEnabled: boolean
  /** False when the caller lacks ap.read — hide every AP-derived figure rather
   * than show zeros (a parties.read-only vendor-directory clerk must not see
   * AP money). */
  apAllowed: boolean
  /** The per-section grants the figures above were computed under. */
  grants: { ap: boolean; orders: boolean; expenses: boolean; parties: boolean }
}

const TREND_WEEKS = 13

type OpenPoRow = {
  party_id: string | null
  name: string | null
  total: string
  currency: string
}

function documentMovements(orgId: string, kinds: string[], from: string, through: string, docScope: SQL) {
  const kindFilter = sql`d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})`;
  return sql`
    select coalesce(d.document_date, d.posting_date)::date as dt, sub.base_currency as func,
           round(abs(d.total * d.fx_rate), 4) as amount
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
     where d.org_id = ${orgId} and ${kindFilter} and d.status in ('posted', 'voided')
       and coalesce(d.document_date, d.posting_date)::date between ${from}::date and ${through}::date${docScope}
    union all
    select coalesce(reversal_entry.posting_date::date, d.voided_at::date) as dt, sub.base_currency as func,
           -round(abs(d.total * d.fx_rate), 4) as amount
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      left join journal_entries reversal_entry on reversal_entry.id = d.reversal_entry_id and reversal_entry.org_id = d.org_id
     where d.org_id = ${orgId} and ${kindFilter} and d.status = 'voided' and d.voided_at is not null
       and coalesce(reversal_entry.posting_date::date, d.voided_at::date) between ${from}::date and ${through}::date${docScope}
  `;
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
  asOf: string,
  rows: readonly OpenPoRow[],
  /** Catalog fallback for orders whose party has no display name. */
  unknownVendor: string,
): Promise<{ byParty: Map<string, { name: string; value: string; count: number }>; total: string }> {
  // One shared rate context instead of a hand-rolled per-currency lookup:
  // the same latest-dated-spot rule (inverse quotes included), with a
  // missing rate failing closed naming the pair and date.
  const fx = await flowRates(orgId, rows.map((row) => ({ func: String(row.currency ?? '').trim().toUpperCase() || null, date: asOf })))
  const byParty = new Map<string, { name: string; value: string; count: number }>()
  let total = '0.0000'
  for (const row of rows) {
    const converted = mulDecimal(
      String(row.total ?? '0'),
      fx.rateAt(String(row.currency ?? '').trim().toUpperCase() || null, asOf),
    )
    total = add(total, converted)
    if (row.party_id) {
      const prior = byParty.get(row.party_id)
      byParty.set(row.party_id, {
        name: prior?.name ?? row.name ?? unknownVendor,
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
  /**
   * Per-section grants using each family's source permission (fail-closed:
   * a caller that omits grants reads no section figures). Without ap.read
   * the AP money queries below never run — the figures are omitted, not
   * zero-shaped — and the loader hides their vitals via `apAllowed`.
   * Orders, expenses and the vendors count are gated the same way on
   * their own family's grant.
   */
  grants: { ap: boolean; orders: boolean; expenses: boolean; parties: boolean } = {
    ap: false,
    orders: false,
    expenses: false,
    parties: false,
  },
): Promise<PurchasingHome> {
  const [ordersOn, expensesOn] = await Promise.all([
    grants.ap && grants.orders ? isFeatureEnabled(orgId, 'orders') : false,
    grants.expenses ? isFeatureEnabled(orgId, 'expenses') : false,
  ])
  const today = await businessToday(orgId)
  // Vendor names fall back to the catalog, never a hardcoded 'Unspecified'.
  const { getTranslations } = await import('next-intl/server')
  const unknownVendor = (await getTranslations('purchasing'))('home.unknownVendor')
  const ago7 = addCalendarDays(today, -7)
  const ago30 = addCalendarDays(today, -30)
  const in7 = addCalendarDays(today, 7)
  const weekStarts = weekStartsEndingOn(today, TREND_WEEKS)
  const trendFrom = weekStarts[0]!
  // An explicitly empty scope is a caller whose visibility resolved to nothing
  // and must read no rows — never degrade to the whole organization. `[]`
  // binds as an empty uuid array so every `= any(...)` leg matches nothing.
  const subArr = subIds !== undefined ? sql`${`{${subIds.join(',')}}`}::uuid[]` : null
  // Document-side reads match root-owned rows only for unrestricted
  // root-covering views; the limb never widens an empty scope (see filters).
  const docScope =
    subArr && includeNullSubsidiary === true && (subIds?.length ?? 0) > 0
      ? sql` and (d.subsidiary_id is null or d.subsidiary_id = any(${subArr}))`
      : subArr
        ? sql` and d.subsidiary_id = any(${subArr})`
        : sql``

  // Open-payables vitals reuse the shared cash engine as of today:
  // the bespoke live aggregate counted future-posted bills while netting
  // future-dated applications, so the pulse never tied to /ap. openItems
  // arrives in presentation currency, exactly like the cockpit's summary.
  // The hero roster groups the SAME item set: its own live
  // aggregate additionally gated on the cached open_balance, so one page
  // showed two different Talent figures.
  // Without the AP grant every money query below is skipped outright: a
  // parties.read-only caller loads no open items, trends, payments, spend or
  // purchase orders. The badges query still runs, but its vendors count is
  // gated on the parties grant like every other family figure; the AP
  // badges it also carries are hidden loader-side via `apAllowed`. Each
  // skipped leg resolves the same row shape it would have returned, so the
  // shared tail needs no branch.
  type TrendRow = { wk: string; func: string | null; late: string | null; spend: string | number }
  type FlowRow = { dt: string; func: string | null; amt: string | number }
  const noTrend = Promise.resolve({ rows: [] as TrendRow[] })
  const noFlows = Promise.resolve({ rows: [] as FlowRow[] })
  const noPos = Promise.resolve({ rows: [] as OpenPoRow[] })
  const [apItems, trendRes, badgeRes, paidRowsRes, spendRowsRes, poRowsRes, orgRes] = (await Promise.all([
    grants.ap ? openItems(orgId, 'ap', today, subIds) : Promise.resolve([]),
    // 13-week billed-spend trend (posted vendor bills by week). Documents
    // translate txn→functional at their maintained rate; the second leg to
    // presentation happens per (week, functional) below.
    grants.ap ? db.execute(sql`
      select date_trunc('week', movement.dt)::date as wk, movement.func,
             max(movement.dt)::text as late, coalesce(sum(movement.amount), 0) as spend
        from (${documentMovements(orgId, ['vendor_bill'], trendFrom, today, docScope)}) movement
       group by 1, 2
    `) : noTrend,
    // Directory badges + the remaining vitals (money scalars moved to the
    // per-(date, functional) row queries below so the second translation leg
    // can run in JS).
    db.execute(sql`
      select
        ${ordersOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'purchase_order'
          and d.status in ('draft', 'pending_approval', 'approved') and d.voided_at is null${docScope})` : sql`0`} as open_pos,
        (select count(*) from documents d where d.org_id = ${orgId} and d.kind in ('vendor_payment', 'check')
          and d.status = 'posted' -- Live entries only: the badge counts payments still posted today
          and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7}) as payments_7d,
        ${expensesOn ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'expense_report'
          and d.status in ('draft', 'pending_approval', 'approved') and d.voided_at is null${docScope})` : sql`0`} as unposted_expenses,
        ${grants.parties ? sql`(select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id and vr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``})` : sql`0`} as vendors
    `),
    // 7-day payment value per (date, functional) for presentation translation.
    grants.ap ? db.execute(sql`
      select movement.dt::text as dt, movement.func, coalesce(sum(movement.amount), 0) as amt
        from (${documentMovements(orgId, ['vendor_payment', 'check'], ago7, today, docScope)}) movement
       group by 1, 2
    `) : noFlows,
    // 30-day billed spend per (date, functional) for presentation translation.
    grants.ap ? db.execute(sql`
      select movement.dt::text as dt, movement.func, coalesce(sum(movement.amount), 0) as amt
        from (${documentMovements(orgId, ['vendor_bill'], ago30, today, docScope)}) movement
       group by 1, 2
    `) : noFlows,
    // Open purchase-order headers translate per-row in JS: POs never post,
    // so they carry no maintained fx_rate and a SQL sum would mix
    // transaction currencies.
    grants.ap && ordersOn
      ? db.execute<OpenPoRow>(sql`
        select d.party_id, p.display_name as name,
               abs(d.total) as total, d.currency
          from documents d
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = 'purchase_order'
           and d.status in ('draft', 'pending_approval', 'approved') and d.voided_at is null${docScope}`)
      : noPos,
    ordersOn
      ? db.execute<{ baseCurrency: string }>(sql`
      select base_currency as "baseCurrency" from orgs where id = ${orgId}`)
      : Promise.resolve({ rows: [] as { baseCurrency: string }[] }),
  ]))

  // Presentation: flows translate at their document-date spot. Balances
  // arrive already translated — openItems returns presentation currency.
  // Missing coverage fails closed.
  // Each week bucket translates at its latest document date, so the rate
  // lookup never runs ahead of the data it translates.
  const trendCtx = grants.ap ? await flowRates(
    orgId,
    trendRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.late ?? r.wk).slice(0, 10) })),
  ) : null
  const byWeek = new Map<string, string>()
  for (const r of trendRes.rows) {
    const wk = String(r.wk).slice(0, 10)
    const late = String(r.late ?? r.wk).slice(0, 10)
    const spend = mulDecimal(String(r.spend ?? 0), trendCtx!.rateAt((r.func ?? null) as string | null, late))
    byWeek.set(wk, add(byWeek.get(wk) ?? '0.0000', spend))
  }
  const paid7dValue = grants.ap ? await translateFlows(
    orgId,
    paidRowsRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.dt).slice(0, 10), amount: String(r.amt ?? 0) })),
  ) : '0'
  const spend30d = grants.ap ? await translateFlows(
    orgId,
    spendRowsRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.dt).slice(0, 10), amount: String(r.amt ?? 0) })),
  ) : '0'

  const orgCurrency = String(orgRes.rows[0]?.baseCurrency ?? '').trim().toUpperCase()
  if (ordersOn && !orgCurrency) throw new Error('organization currency is not configured')
  const po = ordersOn ? await openPoValueInOrgCurrency(orgId, today, poRowsRes.rows, unknownVendor) : { byParty: new Map(), total: '0' }

  // Hero roster — vendor commitments merged from the SAME as-of open items
  // as the pulse with translated open POs, ranked by combined
  // exposure. Per-vendor billed legs net exactly like the /ap cockpit's
  // by-vendor grouping, so the roster ties to both the pulse and /ap by
  // construction. Items without a party cannot join a vendor row and stay
  // pulse-only (the pulse still counts them).
  const billedByParty = new Map<string, {
    name: string
    openBills: number
    billedOpen: string
    overdue: string
    oldestDue: string | null
  }>()
  for (const it of apItems) {
    if (it.partyId == null) continue
    const remaining = String(it.remaining)
    const cur = billedByParty.get(it.partyId) ?? {
      name: String(it.partyName ?? unknownVendor),
      openBills: 0,
      billedOpen: '0',
      overdue: '0',
      oldestDue: null as string | null,
    }
    if (cmp(remaining, '0') > 0) cur.openBills += 1
    cur.billedOpen = add(cur.billedOpen, remaining)
    const due = it.dueDate ? toISO(it.dueDate) : null
    // Past due follows the shared aging rule (see customers.ts): an item
    // ages from its due date, else its posting date.
    const basis = agingBasisDate({ dueDate: it.dueDate, postingDate: it.tranDate })
    const basisIso = basis ? toISO(basis) : null
    if (basisIso !== null && basisIso < today) cur.overdue = add(cur.overdue, remaining)
    if (due && (!cur.oldestDue || due < cur.oldestDue)) cur.oldestDue = due
    billedByParty.set(it.partyId, cur)
  }
  const topExposure = [...new Set([...billedByParty.keys(), ...po.byParty.keys()])]
    .map((partyId) => {
      const b = billedByParty.get(partyId)
      const p = po.byParty.get(partyId)
      return {
        partyId,
        name: String(b?.name ?? p?.name ?? 'Unspecified'),
        openPoValue: p?.value ?? '0',
        openPos: p?.count ?? 0,
        openBills: Number(b?.openBills ?? 0),
        billedOpen: b?.billedOpen ?? '0',
        overdue: b?.overdue ?? '0',
        oldestDue: b?.oldestDue ?? null,
      }
    })
    .sort((x, y) => cmp(add(y.billedOpen, y.openPoValue), add(x.billedOpen, x.openPoValue)))
    .slice(0, 10)

  // Open-payables vitals straight off the shared summary, so the pulse ties
  // to /ap by construction: signed outstanding, overdue as outstanding
  // minus current (the cockpit's own definition), the 7-day window and the
  // open-line count over the same as-of item set.
  const apSummary = summariseSide(apItems, parseISO(today), '0.0000', 0)
  const apOutstanding = apSummary.outstanding
  // Buckets match by index, never by label: summariseSide builds Current
  // first by construction, so a relabelled "Current" bucket cannot hide
  // past-due money in the current column here.
  const apCurrent = apSummary.buckets[0]?.amount ?? '0'
  const apOverdue = cmp(apOutstanding, apCurrent) > 0 ? add(apOutstanding, mulDecimal(apCurrent, '-1')) : '0'
  let openBills = 0
  let dueNext7 = '0'
  for (const it of apItems) {
    const remaining = String(it.remaining)
    if (cmp(remaining, '0') <= 0) continue
    openBills += 1
    const due = it.dueDate ? toISO(it.dueDate) : null
    if (due !== null && due >= today && due < in7) dueNext7 = add(dueNext7, remaining)
  }
  const badge = badgeRes.rows[0] ?? {}
  return {
    apOutstanding,
    apOverdue,
    openBills,
    dueNext7,
    openPoValue: po.total,
    openPos: Number(badge.open_pos ?? 0),
    spend30d,
    topExposure,
    trend: weekStarts.map((weekStart) => ({ weekStart, spend: byWeek.get(weekStart) ?? '0.0000' })),
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
    apAllowed: grants.ap,
    grants,
  }
}
