import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FinancialProfile, CostSource } from '@openbooks/schema'
import { resolveAccountGroups } from './account-groups'

/**
 * Profile-driven project financials — the configurable successor to the hardcoded
 * measures in `project-costing.ts`. Given a project type's `FinancialProfile`, it
 * resolves the full measure catalog (base aggregations + derived formulas) so the
 * Financials P&L renders per-type. All measures are dollars (JS number); money
 * math stays in SQL numeric. Definitions validated to the penny against the
 * NetSuite RESTlet for job 6089 (invoiced $6,206,001.04, cost $6,320,076.85).
 */

const n = (v: unknown): number => (v == null ? 0 : Number(v))

export interface ProjectFinancials {
  /** measure key → dollar value (marginPct is a percentage, not dollars). */
  measures: Record<string, number>
  costByCategory: { category: string; amount: number }[]
  costByAccount: { accountId: string; number: string | null; name: string; amount: number }[]
  documents: { id: string; kind: string; documentNumber: string; documentDate: string; status: string; partyName: string | null; amount: number }[]
  billingMethod: string | null
  contractValue: number
}

/** Resolve the account-id set for an account-group cost source (empty ⇒ no filter). */
async function groupAccountIds(orgId: string, src: CostSource): Promise<string[]> {
  if (src.source !== 'account_group' || !src.dimension) return []
  const { byAccount } = await resolveAccountGroups(src.dimension, orgId)
  const keys = src.groupKeys && src.groupKeys.length ? new Set(src.groupKeys) : null
  const ids: string[] = []
  for (const [accountId, g] of byAccount) if (!keys || keys.has(g.key)) ids.push(accountId)
  return ids
}

/** A GL-cost filter fragment over `journal_lines l` / `accounts a` for a CostSource. */
function costPredicate(src: CostSource, accountIds: string[]): SQL {
  if (src.source === 'none') return sql`false`
  if (src.source === 'account_group') {
    return accountIds.length ? sql`l.account_id = any(${`{${accountIds.join(',')}}`}::uuid[])` : sql`false`
  }
  const types = src.accountTypes ?? []
  if (!types.length) return sql`false`
  return sql`a.type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})`
}

export async function resolveProjectFinancials(
  orgId: string,
  projectId: string,
  profile: FinancialProfile,
): Promise<ProjectFinancials> {
  // Project header (contract value + markup + billing method).
  const projRow = (await db.execute(sql`
    select coalesce((p.custom->>'contractValue')::numeric, 0) as contract_value,
           coalesce((p.custom->>'markupPercent')::numeric, 0) as markup_percent,
           p.billing_method,
           coalesce((select sum(t.estimated_cost) from project_tasks t where t.project_id = p.id), 0) as cost_budget
      from projects p where p.id = ${projectId} and p.org_id = ${orgId}
  `)) as unknown as { rows: { contract_value: string; markup_percent: string; billing_method: string | null; cost_budget: string }[] }
  const proj = projRow.rows[0] ?? { contract_value: '0', markup_percent: '0', billing_method: null, cost_budget: '0' }
  const contractValue = n(proj.contract_value)
  const markup = 1 + n(proj.markup_percent) / 100
  const costBudget = profile.costBudget.source === 'wbs_estimates' ? n(proj.cost_budget) : 0

  // Account-id sets for account-group cost/burden sources.
  const [costIds, burdenIds] = await Promise.all([
    groupAccountIds(orgId, profile.actualCost),
    groupAccountIds(orgId, profile.burden),
  ])

  const invoiceKinds = profile.invoicedToDate.docKinds
  const creditKinds = profile.invoicedToDate.creditKinds
  const kindList = (ks: string[]) => sql.join(ks.map((k) => sql`${k}`), sql`, `)
  const committedKinds = profile.committedCost.docKinds

  const [invRes, costRes, committedRes, unbilledTimeRes, unbilledLineRes, laborRes, burdenRes, byAccountRes, docRes] = await Promise.all([
    // invoicedToDate — LINE-level tagging (dl.project_id); credits subtract.
    db.execute(sql`
      select coalesce(sum(dl.amount) filter (where d.kind in (${kindList(invoiceKinds)})), 0)
           - coalesce(sum(dl.amount) filter (where d.kind in (${kindList(creditKinds.length ? creditKinds : ['__none__'])})), 0) as invoiced
        from document_lines dl join documents d on d.id = dl.document_id
       where dl.org_id = ${orgId} and dl.project_id = ${projectId} and d.status = 'posted'
         and d.kind in (${kindList([...invoiceKinds, ...creditKinds])})`),
    // actualCost + revenuePosted — posted GL tagged to the project.
    db.execute(sql`
      select coalesce(sum(l.amount) filter (where ${costPredicate(profile.actualCost, costIds)}), 0) as cost,
             coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0) as revenue
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
       where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted'`),
    // committedCost — unbilled portion (by line amount) of open (approved)
    // orders. Uses amount × unbilled-fraction rather than qty×unit_price, since
    // migrated orders often carry the amount but no per-unit price.
    db.execute(sql`
      select coalesce(sum(dl.amount * case when coalesce(dl.quantity,0) > 0
                 then greatest(0, (dl.quantity - coalesce(dl.quantity_billed,0)) / dl.quantity) else 1 end), 0) as committed
        from document_lines dl join documents d on d.id = dl.document_id
       where dl.org_id = ${orgId} and dl.project_id = ${projectId}
         and d.status = 'approved' and d.kind in (${kindList(committedKinds.length ? committedKinds : ['__none__'])})
         and (coalesce(dl.quantity,0) = 0 or dl.quantity_billed is null or dl.quantity_billed < dl.quantity)`),
    // unbilled billable time (bill rate / cost×markup) not yet invoiced.
    db.execute(sql`
      select coalesce(sum(te.hours * coalesce(te.bill_rate, 0)), 0) as bill,
             coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as cost, count(*) as cnt
        from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId}
         and te.status = 'approved' and te.is_billable and te.invoiced_by_line_id is null`),
    // unbilled billable cost lines (amount × markup) not yet billed.
    db.execute(sql`
      select coalesce(sum(dl.amount * coalesce(nullif(dl.cost_multiplier, 0), 1)), 0) as bill,
             coalesce(sum(dl.amount), 0) as cost, count(*) as cnt
        from document_lines dl join documents d on d.id = dl.document_id
       where dl.org_id = ${orgId} and dl.project_id = ${projectId}
         and dl.is_billable and dl.billed_by_line_id is null
         and d.status = 'posted' and d.kind in ('vendor_bill','expense_report','card_charge','check','project_charge')`),
    // laborCost — resolved per profile source (payroll JE / time rate / group).
    profile.laborCost.source === 'payroll_je'
      ? db.execute(sql`select coalesce(sum(l.amount), 0) as labor from journal_lines l join journal_entries e on e.id = l.entry_id
           where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted' and e.origin = 'labor_burden'`)
      : profile.laborCost.source === 'time_rate'
        ? db.execute(sql`select coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as labor from time_entries te
             where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'`)
        : db.execute(sql`select 0 as labor`),
    // burden — posted GL to burden accounts.
    profile.burden.source === 'none'
      ? db.execute(sql`select 0 as burden`)
      : db.execute(sql`select coalesce(sum(l.amount) filter (where ${costPredicate(profile.burden, burdenIds)}), 0) as burden
           from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
          where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted'`),
    // cost by account (for the breakdown subtab) — same cost predicate.
    db.execute(sql`
      select a.id as account_id, a.number, a.name, a.type, coalesce(sum(l.amount), 0) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
       where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted'
         and ${costPredicate(profile.actualCost, costIds)}
       group by a.id, a.number, a.name, a.type having coalesce(sum(l.amount),0) <> 0 order by amount desc`),
    // documents on the project (transactions tab).
    db.execute(sql`
      select d.id, d.kind, d.document_number as "documentNumber", d.document_date::text as "documentDate",
             d.status, pt.display_name as "partyName", coalesce(sum(dl.amount),0) as amount
        from documents d join document_lines dl on dl.document_id = d.id
        left join parties pt on pt.id = d.party_id
       where dl.org_id = ${orgId} and dl.project_id = ${projectId}
       group by d.id, pt.display_name order by d.document_date desc, d.document_number desc limit 500`),
  ]) as unknown as { rows: any[] }[]

  const invoicedToDate = n(invRes.rows[0]?.invoiced)
  const actualCost = n(costRes.rows[0]?.cost)
  const revenuePosted = n(costRes.rows[0]?.revenue)
  const committedCost = n(committedRes.rows[0]?.committed)
  const laborCost = n(laborRes.rows[0]?.labor)
  const burden = n(burdenRes.rows[0]?.burden)

  // billable value: what's invoiceable across all work (time + cost lines).
  const unbTimeBill = profile.billableValue.includeUnbilledTime ? n(unbilledTimeRes.rows[0]?.bill) : 0
  const unbLineBill = profile.billableValue.includeUnbilledCostLines
    ? (profile.billableValue.timeRate === 'cost_times_markup'
        ? n(unbilledLineRes.rows[0]?.cost) * markup
        : n(unbilledLineRes.rows[0]?.bill))
    : 0
  const unbilledBillable = unbTimeBill + unbLineBill
  const billableValue = invoicedToDate + unbilledBillable

  // total cost: only the configured components (labor stays inside actual_cost
  // unless split out, avoiding double count).
  const componentSum: Record<string, number> = { actual_cost: actualCost, committed_cost: committedCost, labor_cost: profile.laborCost.source === 'in_actual_cost' ? 0 : laborCost, burden }
  const totalCost = profile.totalCost.components.reduce((a, k) => a + (componentSum[k] ?? 0), 0)

  // total price by method.
  let totalPrice: number
  switch (profile.totalPrice.method) {
    case 'contract_field': totalPrice = contractValue; break
    case 'billable_value': totalPrice = billableValue; break
    case 'not_to_exceed': totalPrice = contractValue > 0 ? Math.min(billableValue, contractValue) : billableValue; break
    case 'cost_plus': totalPrice = totalCost * (profile.totalPrice.defaultMarkupPercent != null && n(proj.markup_percent) === 0 ? 1 + profile.totalPrice.defaultMarkupPercent / 100 : markup); break
    default: totalPrice = contractValue
  }

  const couldBeInvoiced = profile.couldBeInvoiced.formula === 'price_minus_invoiced'
    ? totalPrice - invoicedToDate
    : unbilledBillable
  const grossProfit = totalPrice - totalCost
  const marginPct = totalPrice !== 0 ? (grossProfit / totalPrice) * 100 : 0
  const remainingBudget = costBudget - totalCost

  const measures: Record<string, number> = {
    invoiced_to_date: invoicedToDate,
    revenue_posted: revenuePosted,
    actual_cost: actualCost,
    labor_cost: laborCost,
    burden,
    committed_cost: committedCost,
    billable_value: billableValue,
    unbilled_billable: unbilledBillable,
    cost_budget: costBudget,
    total_price: totalPrice,
    could_be_invoiced: couldBeInvoiced,
    total_cost: totalCost,
    gross_profit: grossProfit,
    margin_pct: marginPct,
    remaining_budget: remainingBudget,
  }

  const costByCategory = new Map<string, number>()
  for (const r of byAccountRes.rows) {
    const cat = r.type === 'cogs' ? 'cogs' : 'operating_expense'
    costByCategory.set(cat, (costByCategory.get(cat) ?? 0) + n(r.amount))
  }

  return {
    measures,
    costByCategory: [...costByCategory].map(([category, amount]) => ({ category, amount })),
    costByAccount: byAccountRes.rows.map((r) => ({ accountId: r.account_id, number: r.number, name: r.name, amount: n(r.amount) })),
    documents: docRes.rows.map((r) => ({ id: r.id, kind: r.kind, documentNumber: r.documentNumber, documentDate: r.documentDate, status: r.status, partyName: r.partyName, amount: n(r.amount) })),
    billingMethod: proj.billing_method,
    contractValue,
  }
}
