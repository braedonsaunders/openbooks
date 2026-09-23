import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday, parseIsoDate } from '@openbooks/engine/src/platform/business-date.ts'
import { add, cmp, div, fromUnits, mul, neg, normalizeMoney, roundDiv, toUnits } from '@openbooks/engine/src/money/money.ts'
import { openItems } from './cash/open-items'
import { paymentStats } from './cash/core'
import { isFeatureEnabled } from './features'
import { resolveProjectFinancials } from './project-financials'
import { loadProjectType } from './project-type'
import { crmActivityScope, crmOpportunityScope, crmSharedScope } from './crm-scope'
import { subsidiaryVisibleFilter } from './subsidiaries'

/**
 * Money travels as canonical numeric(19,4) decimal strings (house bigint
 * helpers through aggregation and JSON; formatted only at the UI edge).
 * openItems deliberately returns exact decimal text, and parseFloat would
 * corrupt it — 0.10 + 0.20 becomes 0.30000000000000004, and amounts above
 * 2^53 lose cents. Counts, days and percents stay numbers; they are not
 * money and never aggregate across currencies.
 */
export type PulseMoney = string

export interface CustomerAgingBreakdown {
  current: PulseMoney
  days1To30: PulseMoney
  days31To60: PulseMoney
  days61To90: PulseMoney
  days90Plus: PulseMoney
  totalOpen: PulseMoney
  totalOverdue: PulseMoney
}

/**
 * Which pulse sections the caller may see. The pulse is a combined payload
 * across domains, so one read permission cannot unlock all of it:
 *
 *   - `ar` covers receivables telemetry (aging, credit terms and headroom,
 *     payment history) and every commercial-document timeline entry
 *     (quotes, sales orders, invoices, payments) — the same `ar.read` the
 *     standalone statement and order surfaces require.
 *   - `crm` covers the relationship side (opportunity pipeline, activity
 *     timeline) — the `crm.accounts.read` the account drawer requires.
 *   - `projects` covers the delivery rollup — `projects.read`.
 *
 * Subsidiary/record scope inside each section is the same scope helper the
 * standalone endpoint for that section enforces; gating here never re-derives
 * it. Sections the caller cannot see are OMITTED from the payload — never
 * nulled with data-shaped defaults, which would read as genuine zeros.
 */
export interface CustomerPulseSections {
  ar: boolean
  crm: boolean
  projects: boolean
}

/**
 * Map effective permissions to pulse sections. Returns null when the caller
 * may see nothing at all — the route turns that into a 403 naming the
 * permissions that would grant access.
 */
export function pulseSectionsFor(
  covers: (permission: string) => boolean,
): CustomerPulseSections | null {
  const sections: CustomerPulseSections = {
    ar: covers('ar.read'),
    crm: covers('crm.accounts.read'),
    projects: covers('projects.read'),
  }
  if (!sections.ar && !sections.crm && !sections.projects) return null
  return sections
}

/**
 * Realized margin percent, exact bigint math (same shape as the project
 * financial reader's margin_pct): null on a zero base, never a float
 * division. Display rounding happens at the UI edge.
 */
export function marginPercent(profit: PulseMoney, base: PulseMoney): number | null {
  const baseUnits = toUnits(base)
  if (baseUnits === 0n) return null
  const negative = baseUnits < 0n
  const signedProfit = toUnits(profit) * (negative ? -1n : 1n)
  const absoluteBase = negative ? -baseUnits : baseUnits
  return Number(fromUnits(roundDiv((signedProfit * 100n * 10_000n), absoluteBase)))
}

export interface CustomerPulseData {
  party: {
    id: string
    displayName: string
    email: string | null
    phone: string | null
    website: string | null
    currency: string
    subsidiaryName: string | null
    /** Credit controls live on the customer role (AR domain): present only with ar.read. */
    paymentTermsName?: string | null
    /** Credit controls live on the customer role (AR domain): present only with ar.read. */
    isOnHold?: boolean
    /** Credit controls live on the customer role (AR domain): present only with ar.read. */
    holdReason?: string | null
    /** Credit controls live on the customer role (AR domain): present only with ar.read. */
    creditLimit?: PulseMoney | null
    /** Credit controls live on the customer role (AR domain): present only with ar.read. */
    hasCreditLimit?: boolean
  }
  /** Echo of the sections granted for this response, so consumers (UI,
   *  assistant tools) can tell "omitted for access" apart from "empty". */
  sections: CustomerPulseSections
  /** Present only with ar.read. */
  aging?: CustomerAgingBreakdown
  /** Present only with ar.read. */
  credit?: {
    creditLimit: PulseMoney | null
    openArBalance: PulseMoney
    unbilledOrdersBalance: PulseMoney
    remainingCredit: PulseMoney | null
    creditUtilizationPercent: number | null
  }
  /** Present only with ar.read. */
  paymentMetrics?: {
    dso: number
    partyAvgDaysToPay: number | null
    orgAvgDaysToPay: number
    settlementsCount: number
  }
  /** Present only with crm.accounts.read. */
  pipeline?: {
    totalOpportunities: number
    openOpportunities: number
    wonOpportunities: number
    lostOpportunities: number
    projectedPipeline: PulseMoney
    weightedPipeline: PulseMoney
    wonAmount: PulseMoney
    winRatePercent: number | null
  }
  /** Present only with projects.read (and the Projects feature enabled). */
  projects?: {
    enabled: boolean
    totalCount: number
    activeCount: number
    totalContractValue: PulseMoney
    totalBilled: PulseMoney
    totalCost: PulseMoney
    grossProfit: PulseMoney
    grossMarginPercent: number | null
  }
  /**
   * Always present but permission-filtered: CRM activities ride the CRM
   * section, commercial documents (quotes, sales orders, invoices,
   * payments) ride the AR section. A caller with neither section gets an
   * empty timeline rather than anyone else's entries.
   */
  timeline: Array<{
    id: string
    type: 'activity' | 'estimate' | 'sales_order' | 'invoice' | 'payment' | 'stage_event'
    title: string
    description: string | null
    amount?: PulseMoney
    currency?: string
    timestamp: string
    status?: string
    reference?: string
  }>
}

export async function loadCustomerPulse(
  partyId: string,
  orgId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
  sections?: CustomerPulseSections,
): Promise<CustomerPulseData | null> {
  // No sections means no access: callers must resolve permissions through
  // pulseSectionsFor first. Defaulting to everything here would reintroduce
  // the leak the parameter exists to close.
  if (!sections || (!sections.ar && !sections.crm && !sections.projects)) return null

  const asOf = await businessToday(orgId)
  const allowedSubArray = allowedSubsidiaryIds ? Array.from(allowedSubsidiaryIds) : undefined

  // 1. Party identity and credit settings
  const partyResult = await db.execute<{
    id: string
    display_name: string
    email: string | null
    phone: string | null
    website: string | null
    currency: string | null
    subsidiary_name: string | null
    terms_name: string | null
    is_on_hold: boolean | null
    hold_reason: string | null
    cr_credit_limit: string | null
  }>(sql`
    select p.id, p.display_name, p.email, p.phone, p.website,
           coalesce(cr.currency, 'USD') as currency,
           sub.name as subsidiary_name,
           pt.name as terms_name,
           coalesce(cr.is_on_hold, false) as is_on_hold,
           cr.hold_reason,
           cr.credit_limit::text as cr_credit_limit
      from parties p
      left join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id
      left join subsidiaries sub on sub.id = p.subsidiary_id and sub.org_id = p.org_id
      left join payment_terms pt on pt.id = cr.payment_terms_id and pt.org_id = p.org_id
     where p.id = ${partyId} and p.org_id = ${orgId}${crmSharedScope(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `)

  const partyRow = partyResult.rows[0]
  if (!partyRow) return null

  // The credit limit lives on the customer role alongside terms and hold
  // state. parties carries no credit columns, so there is no fallback.
  // Canonical decimal text, never parseFloat (see PulseMoney).
  const creditLimitRaw = partyRow.cr_credit_limit
  const hasCreditLimit = creditLimitRaw !== null && creditLimitRaw !== undefined
  const creditLimit = hasCreditLimit ? normalizeMoney(creditLimitRaw!) : null

  const party: CustomerPulseData['party'] = {
    id: partyRow.id,
    displayName: partyRow.display_name,
    email: partyRow.email,
    phone: partyRow.phone,
    website: partyRow.website,
    currency: partyRow.currency ?? 'USD',
    subsidiaryName: partyRow.subsidiary_name,
  }
  // Credit controls are AR-domain facts (same rows the directory's `crm`
  // bundle withholds from crm.accounts.read holders). A caller without
  // ar.read gets identity only — the keys are absent, not nulled.
  if (sections.ar) {
    party.paymentTermsName = partyRow.terms_name
    party.isOnHold = Boolean(partyRow.is_on_hold)
    party.holdReason = partyRow.hold_reason
    party.creditLimit = creditLimit
    party.hasCreditLimit = hasCreditLimit
  }

  // 2-4. Receivables telemetry (AR section only). Skipped entirely without
  // ar.read: no open-item, order-commitment, or payment-history query runs,
  // so no AR figure can reach a CRM-only caller.
  let aging: CustomerPulseData['aging']
  let credit: CustomerPulseData['credit']
  let paymentMetrics: CustomerPulseData['paymentMetrics']
  if (sections.ar) {
    // 2. Open AR items and aging buckets
    const [allOpenItems, stats] = await Promise.all([
      openItems(orgId, 'ar', asOf, allowedSubArray),
      paymentStats('ar', asOf, allowedSubArray, orgId),
    ])

    const customerOpenItems = allOpenItems.filter((item) => item.partyId === partyId)
    const asOfDate = parseIsoDate(asOf)

    // Exact decimal accumulation: openItems returns canonical decimal text
    // and the house bigint helpers keep it exact (0.10 + 0.20 stays
    // "0.3000"; values above 2^53 keep their cents).
    let current = '0'
    let days1To30 = '0'
    let days31To60 = '0'
    let days61To90 = '0'
    let days90Plus = '0'
    let totalOpen = '0'
    let totalOverdue = '0'

    for (const item of customerOpenItems) {
      const val = normalizeMoney(item.remaining)
      totalOpen = add(totalOpen, val)

      if (!item.dueDate) {
        current = add(current, val)
        continue
      }

      const diffDays = Math.floor(
        (asOfDate.getTime() - item.dueDate.getTime()) / (1000 * 60 * 60 * 24),
      )

      if (diffDays <= 0) {
        current = add(current, val)
      } else {
        totalOverdue = add(totalOverdue, val)
        if (diffDays <= 30) days1To30 = add(days1To30, val)
        else if (diffDays <= 60) days31To60 = add(days31To60, val)
        else if (diffDays <= 90) days61To90 = add(days61To90, val)
        else days90Plus = add(days90Plus, val)
      }
    }

    // 3. Unbilled orders (approved/pending sales orders commitment)
    const ordersResult = await db.execute<{ unbilled_total: string | null }>(sql`
      select sum(d.total)::text as unbilled_total
        from documents d
       where d.org_id = ${orgId}
         and d.party_id = ${partyId}
         and d.kind = 'sales_order'
         and d.status in ('pending_approval', 'approved')
         and d.voided_at is null
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds ?? null)}
    `)
    // The SQL sum over numeric(19,4) is exact; keep it decimal text.
    const unbilledOrdersBalance = normalizeMoney(ordersResult.rows[0]?.unbilled_total ?? '0')

    // Remaining credit headroom, exact: limit minus committed (open plus
    // unbilled), floored at zero. Utilization is a display percent derived
    // from the exact strings at the edge — it never feeds another sum.
    let remainingCredit: PulseMoney | null = null
    let creditUtilizationPercent: number | null = null
    if (hasCreditLimit && creditLimit !== null) {
      const committed = add(totalOpen, unbilledOrdersBalance)
      remainingCredit = cmp(committed, creditLimit) > 0 ? '0.0000' : add(creditLimit, neg(committed))
      creditUtilizationPercent = cmp(creditLimit, '0') > 0
        ? Math.min(100, Number(mul(div(committed, creditLimit), '100')))
        : 100
    }

    // 4. Payment metrics & DSO
    const partyStat = stats.map.get(partyId)
    const partyAvgDaysToPay = partyStat ? Math.round(partyStat.avg) : null
    const dso = partyAvgDaysToPay ?? Math.round(stats.globalAvg)

    aging = {
      current: normalizeMoney(current),
      days1To30: normalizeMoney(days1To30),
      days31To60: normalizeMoney(days31To60),
      days61To90: normalizeMoney(days61To90),
      days90Plus: normalizeMoney(days90Plus),
      totalOpen: normalizeMoney(totalOpen),
      totalOverdue: normalizeMoney(totalOverdue),
    }
    credit = {
      creditLimit,
      openArBalance: normalizeMoney(totalOpen),
      unbilledOrdersBalance,
      remainingCredit,
      creditUtilizationPercent,
    }
    paymentMetrics = {
      dso,
      partyAvgDaysToPay,
      orgAvgDaysToPay: Math.round(stats.globalAvg),
      settlementsCount: partyStat?.n ?? 0,
    }
  }

  // 5. Commercial Pipeline (CRM section only)
  let pipeline: CustomerPulseData['pipeline']
  if (sections.crm) {
    const oppsResult = await db.execute<{
      total_count: number
      open_count: number
      won_count: number
      lost_count: number
      projected_sum: string | null
      weighted_sum: string | null
      won_sum: string | null
    }>(sql`
      select count(*)::int as total_count,
             count(*) filter (where not s.is_closed)::int as open_count,
             count(*) filter (where s.is_won)::int as won_count,
             count(*) filter (where s.is_closed and not s.is_won)::int as lost_count,
             sum(case when not s.is_closed then o.projected_amount else 0 end)::text as projected_sum,
             sum(case when not s.is_closed then o.weighted_amount else 0 end)::text as weighted_sum,
             sum(case when s.is_won then o.projected_amount else 0 end)::text as won_sum
        from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
       where o.org_id = ${orgId}
         and o.party_id = ${partyId}
         and o.is_active
         ${crmOpportunityScope(allowedSubsidiaryIds)}
    `)

    const oppRow = oppsResult.rows[0]
    const wonCount = oppRow?.won_count ?? 0
    const lostCount = oppRow?.lost_count ?? 0
    const closedCount = wonCount + lostCount
    const winRatePercent = closedCount > 0 ? Math.round((wonCount / closedCount) * 100) : null

    pipeline = {
      totalOpportunities: oppRow?.total_count ?? 0,
      openOpportunities: oppRow?.open_count ?? 0,
      wonOpportunities: wonCount,
      lostOpportunities: lostCount,
      projectedPipeline: normalizeMoney(oppRow?.projected_sum ?? '0'),
      weightedPipeline: normalizeMoney(oppRow?.weighted_sum ?? '0'),
      wonAmount: normalizeMoney(oppRow?.won_sum ?? '0'),
      winRatePercent,
    }
  }

  // 6. Project Rollups (projects section only, and only when enabled).
  // Cost comes from the governed project financial reader — the same
  // measures the project cockpit Financials tab renders (posted GL cost,
  // invoiced to date, contract value per the project's type profile) — so
  // a billed project with posted costs reports its true margin. The
  // previous code set cost to 0 and margin to 100% without reading any cost
  // source. Profit here is realized billing margin (invoiced minus cost),
  // so the figures always tie: profit + cost = billed.
  let projects: CustomerPulseData['projects']
  if (sections.projects && await isFeatureEnabled(orgId, 'projects')) {
    const listRes = await db.execute<{ id: string; status: string }>(sql`
      select prj.id, prj.status
        from projects prj
       where prj.org_id = ${orgId}
         and prj.customer_id = ${partyId}
         and prj.is_active
         ${subsidiaryVisibleFilter(sql`prj.subsidiary_id`, allowedSubsidiaryIds ?? null)}
    `)
    let contractTotal = '0'
    let billedTotal = '0'
    let costTotal = '0'
    for (const row of listRes.rows) {
      const projectType = await loadProjectType(orgId, row.id)
      const fin = await resolveProjectFinancials(orgId, row.id, projectType.financialProfile)
      contractTotal = add(contractTotal, normalizeMoney(String(fin.contractValue ?? '0')))
      billedTotal = add(billedTotal, normalizeMoney(String(fin.measures.invoiced_to_date ?? '0')))
      costTotal = add(costTotal, normalizeMoney(String(fin.measures.total_cost ?? '0')))
    }
    const profit = add(billedTotal, neg(costTotal))
    projects = {
      enabled: true,
      totalCount: listRes.rows.length,
      activeCount: listRes.rows.filter((r) => r.status === 'awarded' || r.status === 'active').length,
      totalContractValue: normalizeMoney(contractTotal),
      totalBilled: normalizeMoney(billedTotal),
      totalCost: normalizeMoney(costTotal),
      grossProfit: normalizeMoney(profit),
      grossMarginPercent: marginPercent(profit, billedTotal),
    }
  }

  // 7. Unified Activity & Document Timeline, permission-filtered. CRM
  // activities ride the CRM section; commercial documents (quotes, sales
  // orders, invoices, payments) ride the AR section — quotes and sales
  // orders require ar.read on their standalone surfaces, so a CRM-only
  // caller must not read them here either.
  const timelineItems: NonNullable<CustomerPulseData['timeline']> = []

  if (sections.crm) {
    const activitiesRes = await db.execute<{
      id: string
      kind: string
      subject: string
      body: string | null
      status: string
      timestamp: string
    }>(sql`
      select a.id, a.kind, a.subject, a.body, a.status,
             coalesce(a.starts_at, a.due_at, a.created_at)::text as timestamp
        from crm_activities a
        join crm_activity_links l on l.activity_id = a.id and l.org_id = a.org_id
       where l.org_id = ${orgId}
         and l.subject_kind = 'account'
         and l.subject_id = ${partyId}
         and not a.is_private
         ${crmActivityScope(allowedSubsidiaryIds)}
       order by coalesce(a.starts_at, a.due_at, a.created_at) desc
       limit 25
    `)

    for (const a of activitiesRes.rows) {
      timelineItems.push({
        id: a.id,
        type: 'activity',
        title: a.subject,
        description: a.body,
        status: a.status,
        timestamp: a.timestamp,
      })
    }
  }

  if (sections.ar) {
    const documentsRes = await db.execute<{
      id: string
      kind: string
      document_number: string
      document_date: string
      status: string
      currency: string
      total: string
      memo: string | null
    }>(sql`
      select d.id, d.kind, d.document_number, d.document_date::text,
             d.status, d.currency, d.total::text, d.memo
        from documents d
       where d.org_id = ${orgId}
         and d.party_id = ${partyId}
         and d.kind in ('quote', 'sales_order', 'customer_invoice', 'customer_payment')
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds ?? null)}
       order by d.document_date desc, d.created_at desc
       limit 35
    `)

    for (const d of documentsRes.rows) {
      let type: NonNullable<CustomerPulseData['timeline']>[number]['type'] = 'invoice'
      if (d.kind === 'quote') type = 'estimate'
      else if (d.kind === 'sales_order') type = 'sales_order'
      else if (d.kind === 'customer_payment') type = 'payment'

      timelineItems.push({
        id: d.id,
        type,
        title: `${d.document_number} (${d.kind.replace('_', ' ')})`,
        description: d.memo,
        amount: normalizeMoney(d.total),
        currency: d.currency,
        status: d.status,
        timestamp: d.document_date,
        reference: d.document_number,
      })
    }
  }

  // Sort unified feed chronologically desc
  timelineItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return {
    party,
    sections: { ...sections },
    ...(aging !== undefined ? { aging } : null),
    ...(credit !== undefined ? { credit } : null),
    ...(paymentMetrics !== undefined ? { paymentMetrics } : null),
    ...(pipeline !== undefined ? { pipeline } : null),
    ...(projects !== undefined ? { projects } : null),
    timeline: timelineItems.slice(0, 50),
  }
}
