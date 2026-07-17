import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { projectCostSummary, projectTimeSummary, projectUnbilled } from '../../../lib/project-costing'
import { listBillingRequests } from '../../../lib/billing-requests'
import type { ProjectCockpitData } from './ProjectDrawer'

/**
 * Loads everything the project flyout's cockpit tabs need (financials, time,
 * unbilled, charges, billing requests, transactions). Server-only; called from
 * the projects list page when a project flyout is open.
 */
export async function loadProjectCockpit(orgId: string, projectId: string): Promise<ProjectCockpitData> {
  const [summary, time, unbilled, billingRequests, chargeRes, itemRes, recognizedRes] = await Promise.all([
    projectCostSummary(orgId, projectId),
    projectTimeSummary(orgId, projectId),
    projectUnbilled(orgId, projectId),
    listBillingRequests(orgId, projectId),
    db.execute(sql`
      select d.id, d.document_number as "documentNumber", d.document_date as "documentDate", d.status,
             d.total::numeric(19,4) as cost,
             coalesce(sum(dl.amount * coalesce(nullif(dl.cost_multiplier,0),1)) filter (where dl.is_billable), 0)::numeric(19,4) as "billValue",
             count(dl.*) as lines,
             bool_and(dl.billed_by_line_id is not null) filter (where dl.is_billable) as billed
        from documents d left join document_lines dl on dl.document_id = d.id
       where d.org_id = ${orgId} and d.kind = 'project_charge' and d.project_id = ${projectId}
       group by d.id order by d.document_date desc, d.document_number desc`),
    db.execute(sql`
      select id, name, default_cost as "defaultCost", default_rate as "defaultRate"
        from items where org_id = ${orgId} and is_active order by name limit 2000`),
    db.execute(sql`
      select coalesce(-sum(l.amount) filter (where l.amount < 0), 0)::numeric(19,4) as recognized
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted' and e.origin = 'revenue_recognition'`),
  ])

  const charges = (chargeRes as unknown as { rows: any[] }).rows
  const items = (itemRes as unknown as { rows: any[] }).rows
  const recognizedToDate = String((recognizedRes as unknown as { rows: any[] }).rows[0]?.recognized ?? '0')

  return {
    financials: {
      contractValue: summary.budget.contractValue,
      costBudget: summary.budget.cost,
      actualCost: summary.actual.cost,
      committedCost: summary.committed.cost,
      projectedCost: summary.forecast.projectedCost,
      remainingBudget: summary.forecast.remainingBudget,
      actualRevenue: summary.actual.revenue,
      margin: summary.actual.margin,
      unbilledRevenue: unbilled.revenue,
      percentSpent: summary.forecast.percentSpent,
      costByCategory: summary.costByCategory,
      costByAccount: summary.costByAccount,
    },
    time,
    unbilled,
    billingRequests: billingRequests as ProjectCockpitData['billingRequests'],
    charges: charges as ProjectCockpitData['charges'],
    items: items as ProjectCockpitData['items'],
    absorption: {
      recovered: charges.filter((c) => c.status === 'posted').reduce((a, c) => a + Number(c.cost), 0).toFixed(2),
      billValue: charges.reduce((a, c) => a + Number(c.billValue), 0).toFixed(2),
    },
    recognizedToDate,
    transactions: summary.documents as ProjectCockpitData['transactions'],
  }
}
