import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { businessToday, parseIsoDate } from '@openbooks/engine/src/business-date.ts'
import { openItems } from './cash/open-items'
import { paymentStats } from './cash/core'
import { isFeatureEnabled } from './features'
import { crmActivityScope, crmOpportunityScope, crmSharedScope } from './crm-scope'
import { subsidiaryVisibleFilter } from './subsidiaries'

export interface CustomerAgingBreakdown {
  current: number
  days1To30: number
  days31To60: number
  days61To90: number
  days90Plus: number
  totalOpen: number
  totalOverdue: number
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
    paymentTermsName: string | null
    isOnHold: boolean
    holdReason: string | null
    creditLimit: number | null
    hasCreditLimit: boolean
  }
  aging: CustomerAgingBreakdown
  credit: {
    creditLimit: number | null
    openArBalance: number
    unbilledOrdersBalance: number
    remainingCredit: number | null
    creditUtilizationPercent: number | null
  }
  paymentMetrics: {
    dso: number
    partyAvgDaysToPay: number | null
    orgAvgDaysToPay: number
    settlementsCount: number
  }
  pipeline: {
    totalOpportunities: number
    openOpportunities: number
    wonOpportunities: number
    lostOpportunities: number
    projectedPipeline: number
    weightedPipeline: number
    wonAmount: number
    winRatePercent: number | null
  }
  projects: {
    enabled: boolean
    totalCount: number
    activeCount: number
    totalContractValue: number
    totalBilled: number
    totalCost: number
    grossProfit: number
    grossMarginPercent: number | null
  }
  timeline: Array<{
    id: string
    type: 'activity' | 'estimate' | 'sales_order' | 'invoice' | 'payment' | 'stage_event'
    title: string
    description: string | null
    amount?: number
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
): Promise<CustomerPulseData | null> {
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
  const creditLimitRaw = partyRow.cr_credit_limit
  const hasCreditLimit = creditLimitRaw !== null && creditLimitRaw !== undefined
  const creditLimitNum = hasCreditLimit ? parseFloat(creditLimitRaw!) || 0 : null

  // 2. Open AR items and aging buckets
  const [allOpenItems, stats, projectsEnabled] = await Promise.all([
    openItems(orgId, 'ar', asOf, allowedSubArray),
    paymentStats('ar', asOf, allowedSubArray, orgId),
    isFeatureEnabled(orgId, 'projects'),
  ])

  const customerOpenItems = allOpenItems.filter((item) => item.partyId === partyId)
  const asOfDate = parseIsoDate(asOf)

  let current = 0
  let days1To30 = 0
  let days31To60 = 0
  let days61To90 = 0
  let days90Plus = 0
  let totalOpen = 0
  let totalOverdue = 0

  for (const item of customerOpenItems) {
    const val = parseFloat(item.remaining) || 0
    totalOpen += val

    if (!item.dueDate) {
      current += val
      continue
    }

    const diffDays = Math.floor(
      (asOfDate.getTime() - item.dueDate.getTime()) / (1000 * 60 * 60 * 24),
    )

    if (diffDays <= 0) {
      current += val
    } else {
      totalOverdue += val
      if (diffDays <= 30) days1To30 += val
      else if (diffDays <= 60) days31To60 += val
      else if (diffDays <= 90) days61To90 += val
      else days90Plus += val
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
  const unbilledOrdersBalance = parseFloat(ordersResult.rows[0]?.unbilled_total ?? '0') || 0

  // Remaining credit headroom
  let remainingCredit: number | null = null
  let creditUtilizationPercent: number | null = null
  if (hasCreditLimit && creditLimitNum !== null) {
    const committed = totalOpen + unbilledOrdersBalance
    remainingCredit = Math.max(0, creditLimitNum - committed)
    creditUtilizationPercent = creditLimitNum > 0 ? Math.min(100, (committed / creditLimitNum) * 100) : 100
  }

  // 4. Payment metrics & DSO
  const partyStat = stats.map.get(partyId)
  const partyAvgDaysToPay = partyStat ? Math.round(partyStat.avg) : null
  const dso = partyAvgDaysToPay ?? Math.round(stats.globalAvg)

  // 5. Commercial Pipeline
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

  // 6. Project Rollups (if enabled)
  let projectsData = {
    enabled: projectsEnabled,
    totalCount: 0,
    activeCount: 0,
    totalContractValue: 0,
    totalBilled: 0,
    totalCost: 0,
    grossProfit: 0,
    grossMarginPercent: null as number | null,
  }

  if (projectsEnabled) {
    const projectsResult = await db.execute<{
      total_count: number
      active_count: number
      total_contract: string | null
      total_billed: string | null
    }>(sql`
      select count(*)::int as total_count,
             count(*) filter (where prj.status in ('awarded', 'active'))::int as active_count,
             sum(coalesce(prj.contract_value, 0))::text as total_contract,
             coalesce((
               select sum(d.total) from documents d
                where d.org_id = ${orgId} and d.party_id = ${partyId}
                  and d.kind = 'customer_invoice' and d.status = 'posted'
                  and d.project_id is not null
                  ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds ?? null)}
             ), 0)::text as total_billed
        from projects prj
       where prj.org_id = ${orgId}
         and prj.customer_id = ${partyId}
         and prj.is_active
         ${subsidiaryVisibleFilter(sql`prj.subsidiary_id`, allowedSubsidiaryIds ?? null)}
    `)
    const prjRow = projectsResult.rows[0]
    if (prjRow) {
      const contract = parseFloat(prjRow.total_contract ?? '0') || 0
      const billed = parseFloat(prjRow.total_billed ?? '0') || 0
      projectsData = {
        enabled: true,
        totalCount: prjRow.total_count ?? 0,
        activeCount: prjRow.active_count ?? 0,
        totalContractValue: contract,
        totalBilled: billed,
        totalCost: 0,
        grossProfit: billed,
        grossMarginPercent: billed > 0 ? 100 : null,
      }
    }
  }

  // 7. Unified Activity & Document Timeline
  const [activitiesRes, documentsRes] = await Promise.all([
    db.execute<{
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
    `),
    db.execute<{
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
    `),
  ])

  const timelineItems: CustomerPulseData['timeline'] = []

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

  for (const d of documentsRes.rows) {
    let type: CustomerPulseData['timeline'][number]['type'] = 'invoice'
    if (d.kind === 'quote') type = 'estimate'
    else if (d.kind === 'sales_order') type = 'sales_order'
    else if (d.kind === 'customer_payment') type = 'payment'

    timelineItems.push({
      id: d.id,
      type,
      title: `${d.document_number} (${d.kind.replace('_', ' ')})`,
      description: d.memo,
      amount: parseFloat(d.total) || 0,
      currency: d.currency,
      status: d.status,
      timestamp: d.document_date,
      reference: d.document_number,
    })
  }

  // Sort unified feed chronologically desc
  timelineItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return {
    party: {
      id: partyRow.id,
      displayName: partyRow.display_name,
      email: partyRow.email,
      phone: partyRow.phone,
      website: partyRow.website,
      currency: partyRow.currency ?? 'USD',
      subsidiaryName: partyRow.subsidiary_name,
      paymentTermsName: partyRow.terms_name,
      isOnHold: Boolean(partyRow.is_on_hold),
      holdReason: partyRow.hold_reason,
      creditLimit: creditLimitNum,
      hasCreditLimit,
    },
    aging: {
      current,
      days1To30,
      days31To60,
      days61To90,
      days90Plus,
      totalOpen,
      totalOverdue,
    },
    credit: {
      creditLimit: creditLimitNum,
      openArBalance: totalOpen,
      unbilledOrdersBalance,
      remainingCredit,
      creditUtilizationPercent,
    },
    paymentMetrics: {
      dso,
      partyAvgDaysToPay,
      orgAvgDaysToPay: Math.round(stats.globalAvg),
      settlementsCount: partyStat?.n ?? 0,
    },
    pipeline: {
      totalOpportunities: oppRow?.total_count ?? 0,
      openOpportunities: oppRow?.open_count ?? 0,
      wonOpportunities: wonCount,
      lostOpportunities: lostCount,
      projectedPipeline: parseFloat(oppRow?.projected_sum ?? '0') || 0,
      weightedPipeline: parseFloat(oppRow?.weighted_sum ?? '0') || 0,
      wonAmount: parseFloat(oppRow?.won_sum ?? '0') || 0,
      winRatePercent,
    },
    projects: projectsData,
    timeline: timelineItems.slice(0, 50),
  }
}
