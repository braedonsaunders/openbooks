import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import {
  addCalendarDays, businessToday, weekStartsEndingOn,
} from '@openbooks/engine/src/platform/business-date.ts'
import { isoDateOf } from '@openbooks/engine/src/platform/civil-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { add, cmp, mulDecimal } from '@openbooks/engine/src/money/money.ts'
import { agingBasisDate } from '../aging-basis'
import { resolvePeriod } from '../periods'
import { flowRates, translateFlows } from '../fx-presentation'
import { calculateForecast, type ForecastRow } from '../crm'
import { crmOpportunityScope } from '../crm-scope'
import { isFeatureEnabled } from '../features'
import { paymentStats } from '../cash/core'
import { openItems } from '../cash/open-items'

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
  open: string
  overdue: string
  openInvoices: number
  openOpportunities: number
  oldestDue: string | null
}

export interface CustomersHome {
  arOutstanding: string
  arOverdue: string
  openInvoices: number
  overdueInvoices: number
  activeCustomers: number
  /**
   * The ONE org settlement mean — the same settlement-weighted trailing mean
   * the cash cockpit, cashflow analytics, MCP cashflow tool, get_vitals, and
   * customer intelligence quote. Null with no settlements: never an invented
   * figure.
   */
  dso: number | null
  pipeline: { total: string; weighted: string; closed: string }
  topExposure: CustomerExposureRow[]
  /** Weekly collections (posted customer payments), oldest → newest. */
  trend: { weekStart: string; collected: string }[]
  badges: {
    openOpportunities: number
    openQuotes: number
    openSalesOrders: number
    receipts7d: number
    collected7d: string
    customers: number
  }
  /**
   * False when Orders is off OR the caller lacks the orders read grant
   * (quotes and sales orders read behind ar.read at their source) — hide
   * quote/SO vitals rather than show zeros.
   */
  ordersEnabled: boolean
  /**
   * False when CRM is off OR the caller lacks the CRM read grant (the
   * pipeline and opportunity counts read behind crm.opportunities.read at
   * their source) — hide pipeline/opportunity vitals rather than show zeros.
   */
  crmEnabled: boolean
  /**
   * False when the caller lacks ar.read. The AR families
   * (balances, collections, DSO, roster) are then skipped, never
   * zero-shaped — the view hides their vitals.
   */
  arAllowed: boolean
  /**
   * False when the caller lacks parties.read. The directory
   * and customer count are then skipped — the view hides them.
   */
  partiesAllowed: boolean
}

const TREND_WEEKS = 13

function customerPaymentMovements(orgId: string, from: string, through: string, docScope: SQL) {
  return sql`
    select coalesce(d.document_date, d.posting_date)::date as dt,
           sub.base_currency as func, round(abs(d.total * d.fx_rate), 4) as amount
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
     where d.org_id = ${orgId} and d.kind = 'customer_payment' and d.status in ('posted', 'voided')
       ${docScope}
       and coalesce(d.document_date, d.posting_date)::date between ${from}::date and ${through}::date
    union all
    select d.voided_at::date as dt,
           sub.base_currency as func, -round(abs(d.total * d.fx_rate), 4) as amount
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
     where d.org_id = ${orgId} and d.kind = 'customer_payment' and d.status = 'voided'
       and d.voided_at::date between ${from}::date and ${through}::date
       ${docScope}
  `
}

/**
 * Forecast rollups retain each opportunity's transaction currency. The
 * customer home has one organization-currency scalar, so translate every
 * currency at the latest dated spot rate before adding the rows.
 */
async function pipelineInOrgCurrency(
  orgId: string,
  asOf: string,
  rows: readonly ForecastRow[],
): Promise<{ total: string; weighted: string; closed: string }> {
  // One shared rate context instead of a hand-rolled per-currency lookup:
  // the same latest-dated-spot rule (inverse quotes included), with a
  // missing rate failing closed naming the pair and date.
  const fx = await flowRates(orgId, rows.map((row) => ({ func: String(row.currency).trim().toUpperCase() || null, date: asOf })))
  let total = '0.0000'
  let weighted = '0.0000'
  let closed = '0.0000'
  for (const row of rows) {
    const rate = fx.rateAt(String(row.currency).trim().toUpperCase() || null, asOf)
    total = add(total, mulDecimal(row.pipeline_amount ?? '0', rate))
    weighted = add(weighted, mulDecimal(row.weighted_amount ?? '0', rate))
    closed = add(closed, mulDecimal(row.closed_amount ?? '0', rate))
  }
  return { total, weighted, closed }
}

/**
 * Per-section read grants for the customers home. Each
 * payload family keeps the permission its native source page requires —
 * open receivables, collections, and quotes/sales orders read behind
 * `ar.read` (receivables cockpit, estimates, file-cabinet kind map); the
 * pipeline and opportunity counts read behind `crm.opportunities.read`
 * (opportunities board and the application opportunity readers); the
 * directory reads behind `parties.read`. The loader SKIPS ungranted
 * families and flags them on the returned home, so an unauthorized metric
 * is omitted, never a data-shaped zero. Omit the whole parameter only
 * where every family is granted (tests, trusted callers).
 */
export interface CustomersHomeGrants {
  ar: boolean
  crm: boolean
  parties: boolean
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
  grants?: CustomersHomeGrants,
): Promise<CustomersHome> {
  // Section grants default open so existing callers keep
  // their payload; the /customers loader always passes explicit grants.
  const arGranted = grants?.ar ?? true
  const crmGranted = grants?.crm ?? true
  const partiesGranted = grants?.parties ?? true
  const [ordersOn, crmOn] = await Promise.all([
    isFeatureEnabled(orgId, 'orders'),
    isFeatureEnabled(orgId, 'crm'),
  ])
  const today = await businessToday(orgId)
  const ago7 = addCalendarDays(today, -7)
  const weekStarts = weekStartsEndingOn(today, TREND_WEEKS)
  const trendFrom = weekStarts[0]!
  const subArr = subIds !== undefined ? sql`${`{${subIds.join(',')}}`}::uuid[]` : null
  // Document-side reads match root-owned rows only for unrestricted
  // root-covering views; the limb never widens an empty scope (see filters).
  const docScope =
    subArr && includeNullSubsidiary === true && (subIds?.length ?? 0) > 0
      ? sql` and (d.subsidiary_id is null or d.subsidiary_id = any(${subArr}))`
      : subArr
        ? sql` and d.subsidiary_id = any(${subArr})`
        : sql``
  // The pipeline forecast covers the FISCAL quarter (declared calendars
  // honoured), never the calendar quarter — the cockpit and the forecast
  // it quotes must agree on which quarter "this quarter" is.
  const quarter = await resolvePeriod('this_fiscal_quarter', { orgId, today })

  const [arItems, dsoStats, trendRes, badgeRes, collectedRowsRes, forecast, orgRes, oppRes] = (await Promise.all([
    arGranted ? openItems(orgId, 'ar', today, subIds) : Promise.resolve([]),
    // Days-to-settle is the ONE org mean from the cash engine's maintained
    // settlement rollup — the same reader the cash cockpit, cashflow
    // analytics, MCP cashflow tool, get_vitals, and customer intelligence
    // quote — never a second local grain. The rollup scan keeps this landing
    // cheap; subsidiary scoping rides the engine's own rules. The AR
    // settlement rollup is unreadable without ar.read, and an unreadable
    // rollup is null — never a zero that reads as "settles today".
    arGranted ? paymentStats("ar", today, subIds, orgId) : Promise.resolve({ map: new Map<string, { avg: number; sd: number; n: number }>(), globalAvg: null }),
    // 13-week collections trend retains the original receipt in its posting
    // week and records a void as a negative movement in the void week.
    // Skipped without ar.read — never queried, never shaped.
    arGranted ? db.execute(sql`
      select date_trunc('week', movement.dt)::date as wk, movement.func,
             max(movement.dt)::text as late, coalesce(sum(movement.amount), 0) as collected
        from (${customerPaymentMovements(orgId, trendFrom, today, docScope)}) movement
       group by 1, 2
    `) : Promise.resolve({ rows: [] }),
    // Directory badges — cheap counts for the workspace's other pages (the
    // collected-value scalar moved to the row query below for translation).
    // Each badge keeps its source permission — opportunity
    // counts behind crm.opportunities.read, quotes/sales orders and
    // receipts behind ar.read, the customer count behind parties.read.
    db.execute(sql`
      select
        ${crmOn && crmGranted ? sql`(select count(*) from crm_opportunities o join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
          where o.org_id = ${orgId} ${crmOpportunityScope(subIds === undefined ? null : new Set(subIds))} and o.is_active and not s.is_closed)` : sql`0`} as open_opps,
        ${ordersOn && arGranted ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'quote'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as open_quotes,
        ${ordersOn && arGranted ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'sales_order'
          and d.status not in ('closed', 'cancelled') and d.voided_at is null${docScope})` : sql`0`} as open_sos,
        ${arGranted ? sql`(select count(*) from documents d where d.org_id = ${orgId} and d.kind = 'customer_payment'
          and d.status = 'posted' -- Live entries only: the live receipt count excludes payments voided by the current snapshot
          and d.voided_at is null${docScope}
          and coalesce(d.document_date, d.posting_date) >= ${ago7})` : sql`0`} as receipts_7d,
        ${partiesGranted ? sql`(select count(*) from parties p where p.org_id = ${orgId} and p.is_active
          and exists (select 1 from customer_roles cr where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)
          ${subArr ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${subArr}))` : sql``})` : sql`0`} as customers
    `),
    // 7-day net collections per (date, functional), including voids that
    // reverse an earlier receipt inside this window.
    // Skipped without ar.read — never queried, never shaped.
    arGranted ? db.execute(sql`
      select movement.dt::text as dt, movement.func, coalesce(sum(movement.amount), 0) as amt
        from (${customerPaymentMovements(orgId, ago7, today, docScope)}) movement
       group by 1, 2
    `) : Promise.resolve({ rows: [] }),
    crmOn && crmGranted ? calculateForecast({ orgId, periodStart: quarter.from, periodEnd: quarter.to, allowedSubsidiaryIds: subIds === undefined ? null : new Set(subIds) }) : Promise.resolve([]),
    db.execute<{ baseCurrency: string }>(sql`
      select base_currency as "baseCurrency" from orgs where id = ${orgId}
    `),
    crmOn && crmGranted && arGranted ? db.execute<{ party_id: string; n: string }>(sql`
      select o.party_id, count(*) as n
        from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
       where o.org_id = ${orgId} ${crmOpportunityScope(subIds === undefined ? null : new Set(subIds))}
         and o.is_active and not s.is_closed
       group by o.party_id
    `) : Promise.resolve({ rows: [] }),
  ]))

  // Open-item balances arrive in presentation currency from the shared cash
  // reader. Collection flows translate at their document-date spot; missing
  // coverage fails closed.
  // Each week bucket translates at its latest document date, so the rate
  // lookup never runs ahead of the data it translates.
  const trendCtx = await flowRates(
    orgId,
    trendRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.late ?? r.wk).slice(0, 10) })),
  )
  const byWeek = new Map<string, string>()
  for (const r of trendRes.rows) {
    const wk = String(r.wk).slice(0, 10)
    const late = String(r.late ?? r.wk).slice(0, 10)
    const collected = mulDecimal(String(r.collected ?? '0'), trendCtx.rateAt((r.func ?? null) as string | null, late))
    byWeek.set(wk, add(byWeek.get(wk) ?? '0.0000', collected))
  }
  const collected7d = add('0.0000', await translateFlows(
    orgId,
    collectedRowsRes.rows.map((r) => ({ func: (r.func ?? null) as string | null, date: String(r.dt).slice(0, 10), amount: String(r.amt ?? 0) })),
  ))

  const openOppsByParty = new Map(oppRes.rows.map((row) => [row.party_id, Number(row.n)]))
  let arOutstanding = '0.0000'
  let arOverdue = '0.0000'
  let openInvoices = 0
  let overdueInvoices = 0
  // The shared open-item population supplies both the summary and hero
  // roster, so voids, applications and book selection stay consistent.
  const byParty = new Map<string, {
    name: string
    open: string
    overdue: string
    openInvoices: number
    openOpportunities: number
    oldestDue: string | null
  }>()
  for (const item of arItems) {
    const partyId = item.partyId ?? 'null'
    const cur = byParty.get(partyId) ?? {
      name: item.partyName, open: '0.0000', overdue: '0.0000', openInvoices: 0,
      openOpportunities: openOppsByParty.get(partyId) ?? 0, oldestDue: null as string | null,
    }
    cur.open = add(cur.open, item.remaining)
    cur.openInvoices += 1
    openInvoices += 1
    arOutstanding = add(arOutstanding, item.remaining)
    const due = item.dueDate ? isoDateOf(item.dueDate) : null
    // Past due follows the shared aging rule: an item ages from its due
    // date, else its posting date — an untermed invoice is due on issue, so
    // it can never hide as permanently current here while the aging report
    // shows it 90+ days past due.
    const basis = agingBasisDate({ dueDate: item.dueDate, postingDate: item.tranDate })
    const basisIso = basis ? isoDateOf(basis) : null
    if (basisIso && basisIso < today) {
      cur.overdue = add(cur.overdue, item.remaining)
      arOverdue = add(arOverdue, item.remaining)
      overdueInvoices += 1
    }
    if (due && (!cur.oldestDue || due < cur.oldestDue)) cur.oldestDue = due
    byParty.set(partyId, cur)
  }
  const topExposure = [...byParty.entries()]
    .map(([partyId, b]) => ({ partyId, ...b }))
    .sort((x, y) => cmp(y.open, x.open))
    .slice(0, 10)

  const badge = badgeRes.rows[0] ?? {}
  const orgCurrency = String(orgRes.rows[0]?.baseCurrency ?? '').trim().toUpperCase()
  if (!orgCurrency) throw new Error('organization currency is not configured')
  const pipeline = await pipelineInOrgCurrency(orgId, today, forecast)

  return {
    arOutstanding,
    arOverdue,
    openInvoices,
    overdueInvoices,
    activeCustomers: Number(badge.customers ?? 0),
    dso: dsoStats.globalAvg,
    pipeline,
    topExposure,
    trend: weekStarts.map((weekStart) => ({ weekStart, collected: byWeek.get(weekStart) ?? '0.0000' })),
    badges: {
      openOpportunities: Number(badge.open_opps ?? 0),
      openQuotes: Number(badge.open_quotes ?? 0),
      openSalesOrders: Number(badge.open_sos ?? 0),
      receipts7d: Number(badge.receipts_7d ?? 0),
      collected7d,
      customers: Number(badge.customers ?? 0),
    },
    // Feature AND grant — an ungranted family hides its
    // vitals in the view instead of rendering data-shaped zeros.
    ordersEnabled: ordersOn && arGranted,
    crmEnabled: crmOn && crmGranted,
    arAllowed: arGranted,
    partiesAllowed: partiesGranted,
  }
}
