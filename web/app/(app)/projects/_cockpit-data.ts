import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { recognitionAccounts } from '@openbooks/engine/src/project-recognition.ts'
import { projectTimeSummary, projectUnbilled } from '../../../lib/project-costing'
import { resolveProjectFinancials } from '../../../lib/project-financials'
import { loadProjectType } from '../../../lib/project-type'
import { listBillingRequests } from '../../../lib/billing-requests'
import { resolveInvoicingPreference } from '../../../lib/invoicing-preference'
import type { ProjectCockpitData } from './ProjectDrawer'
import { formatMoney, mulPercent, sum } from '@openbooks/engine/src/money.ts'

/**
 * Loads everything the project flyout's cockpit tabs need. The Financials tab is
 * now profile-driven: the project's project type supplies the P&L measure
 * definitions + layout, and resolveProjectFinancials computes the measures.
 */
export async function loadProjectCockpit(orgId: string, projectId: string): Promise<ProjectCockpitData> {
  const projectType = await loadProjectType(orgId, projectId)
  const [financials, time, unbilled, billingRequests, invoicing, chargeRes, itemRes, equipmentRes, recognizedRes] = await Promise.all([
    resolveProjectFinancials(orgId, projectId, projectType.financialProfile),
    projectTimeSummary(orgId, projectId),
    projectUnbilled(orgId, projectId),
    listBillingRequests(orgId, projectId),
    resolveInvoicingPreference(orgId, projectId),
    db.execute(sql`
      select d.id, d.document_number as "documentNumber", d.document_date as "documentDate", d.status,
             d.total::numeric(19,4) as cost,
             coalesce(sum(coalesce(dl.bill_amount, dl.amount * coalesce(nullif(dl.cost_multiplier,0),1))) filter (where dl.is_billable), 0)::numeric(19,4) as "billValue",
             count(dl.*) as lines,
             bool_and(dl.billed_by_line_id is not null) filter (where dl.is_billable) as billed
        from documents d left join document_lines dl on dl.document_id = d.id
       where d.org_id = ${orgId} and d.kind = 'project_charge' and d.project_id = ${projectId}
       group by d.id order by d.document_date desc, d.document_number desc`),
    db.execute(sql`
      select id, name, default_cost as "defaultCost", default_rate as "defaultRate"
        from items where org_id = ${orgId} and is_active order by name limit 2000`),
    db.execute(sql`
      select id, name, unit_number as "unitNumber", charge_item_id as "itemId"
        from equipment_units where org_id = ${orgId} and status = 'active'
         and subsidiary_id = (select subsidiary_id from projects where id = ${projectId} and org_id = ${orgId})
       order by unit_number limit 2000`),
    db.execute(sql`
      select c.id as contract_id, o.percent_complete, o.allocated_price,
             coalesce(p.custom->>'percentCompleteOverride', '') as override_raw,
             coalesce((select sum(l.recognized_amount)
                         from recognition_schedules s
                         join accounting_books bk on bk.id = s.book_id and bk.is_primary
                         join recognition_schedule_lines l on l.schedule_id = s.id
                        where s.obligation_id = o.id and l.journal_entry_id is not null), 0)::numeric(19,4) as recognized
        from projects p
        left join revenue_contracts c on c.org_id = p.org_id and c.project_id = p.id
        left join performance_obligations o on o.contract_id = c.id
       where p.id = ${projectId} and p.org_id = ${orgId}`),
  ])

  const charges = (chargeRes as unknown as { rows: any[] }).rows
  const items = (itemRes as unknown as { rows: any[] }).rows
  const equipment = (equipmentRes as unknown as { rows: any[] }).rows

  // Recognition status for the Financials tab card — shown for fixed-price /
  // percent-complete project types; posting stays with the central run.
  const recRow = (recognizedRes as unknown as { rows: any[] }).rows[0]
  const recognitionPolicy = projectType.invoicingProfile.recognition
  let recognition = null
  if (recognitionPolicy === 'percent_complete_cost') {
    const accts = await recognitionAccounts(orgId)
    const contractValue = String(recRow?.allocated_price ?? financialsContractValue(financials.measures))
    const pct = Number(recRow?.percent_complete ?? 0)
    const overrideValue = recRow?.override_raw !== '' && recRow?.override_raw != null ? Number(recRow.override_raw) : null
    recognition = {
      contractId: (recRow?.contract_id as string | null) ?? null,
      contractValue,
      percentComplete: pct,
      overridden: overrideValue != null,
      overrideValue,
      earned: mulPercent(contractValue, String(recRow?.percent_complete ?? '0')),
      recognized: String(recRow?.recognized ?? '0'),
      accountsMapped: Boolean(accts.unbilledReceivable && accts.projectRevenue),
    }
  }

  return {
    financials: {
      measures: financials.measures,
      layout: projectType.financialProfile.layout,
      costByCategory: financials.costByCategory,
      costByAccount: financials.costByAccount,
      projectType: financials.projectType,
      costBudgetApplies: projectType.financialProfile.totalPrice.method === 'not_to_exceed',
    },
    projectType: { key: projectType.key, name: projectType.name },
    time,
    unbilled,
    billingRequests: billingRequests as ProjectCockpitData['billingRequests'],
    invoicing: {
      billingProcedure: invoicing.billingProcedure,
      allowedBases: invoicing.allowedBases,
      defaultBasis: invoicing.defaultBasis,
      backupRequired: invoicing.backupRequired,
      backupType: invoicing.backupType,
      allowedBackupTypes: invoicing.allowedBackupTypes,
      source: invoicing.source,
    },
    charges: charges as ProjectCockpitData['charges'],
    items: items as ProjectCockpitData['items'],
    equipment: equipment as ProjectCockpitData['equipment'],
    absorption: {
      recovered: formatMoney(sum(charges.filter((c) => c.status === 'posted').map((c) => String(c.cost))), 2),
      billValue: formatMoney(sum(charges.map((c) => String(c.billValue))), 2),
    },
    recognition,
    transactions: financials.documents as ProjectCockpitData['transactions'],
  }
}

/** Contract value fallback for projects not yet synced into a contract. */
function financialsContractValue(measures: Record<string, string | number>): string {
  return String(measures.total_price ?? 0)
}
