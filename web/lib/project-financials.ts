import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FinancialProfile, CostSource, OverheadSource } from '@openbooks/schema'
import { resolveAccountGroups } from './account-groups'
import { trueCostData } from './analytics/true-cost-data'

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

/**
 * rate_engine overhead — the Rassaun/Gantry model. Reuses the True Cost rate
 * engine's per-department composite burden rate ($/hr = overhead pool ÷ billed
 * hours) and applies it to THIS project's labor hours:
 *   overhead = Σ_dept ( project hours-in-dept × dept composite rate )
 * Purely statistical — no GL posting. Rates are computed live over a trailing
 * 12-month window (standard/effective-dated rates land with the rate table).
 */
async function rateEngineOverhead(
  orgId: string,
  projectId: string,
  cfg: OverheadSource['rateEngine'],
): Promise<number> {
  const basis = cfg?.hoursBasis ?? 'billed_hours'
  const scope = cfg?.scope ?? 'department'

  // Trailing-12-month window ending today (annual overhead ÷ annual hours).
  const to = new Date()
  const from = new Date(to)
  from.setFullYear(from.getFullYear() - 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const tc = await trueCostData(orgId, { from: iso(from), to: iso(to), label: 'TTM' })

  // Project approved hours by department.
  const rows = (await db.execute(sql`
    select te.department_id as dept,
           coalesce(sum(te.hours), 0) as total,
           coalesce(sum(te.hours) filter (where te.is_billable), 0) as billed
      from time_entries te
     where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
     group by te.department_id`)) as unknown as { rows: { dept: string | null; total: string; billed: string }[] }

  const hoursOf = (r: { total: string; billed: string }) => n(basis === 'total_hours' ? r.total : r.billed)

  if (scope === 'department') {
    const rateByDept = new Map(tc.departments.map((d) => [d.id, d.composite]))
    // Untagged/unknown-department hours fall back to the overall composite.
    return rows.rows.reduce((sum, r) => sum + hoursOf(r) * (rateByDept.get(r.dept ?? '') ?? tc.kpis.compositeRate), 0)
  }
  // flat / class → overall composite × the project's hours.
  const projectHours = rows.rows.reduce((sum, r) => sum + hoursOf(r), 0)
  return projectHours * tc.kpis.compositeRate
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

  // Account-id sets for account-group cost sources. Overhead only reads GL when
  // its method is the legacy account_group_actual; every other method is a
  // statistical rate applied below (never a GL sum).
  const overheadCostSource: CostSource =
    profile.overhead.method === 'account_group_actual' && profile.overhead.accountGroup
      ? { source: 'account_group', dimension: profile.overhead.accountGroup.dimension, groupKeys: profile.overhead.accountGroup.groupKeys }
      : { source: 'none' }
  const [costIds, overheadIds] = await Promise.all([
    groupAccountIds(orgId, profile.actualCost),
    groupAccountIds(orgId, overheadCostSource),
  ])

  const invoiceKinds = profile.invoicedToDate.docKinds
  const creditKinds = profile.invoicedToDate.creditKinds
  const kindList = (ks: string[]) => sql.join(ks.map((k) => sql`${k}`), sql`, `)
  const committedKinds = profile.committedCost.docKinds

  const [invRes, costRes, committedRes, unbilledTimeRes, unbilledLineRes, laborRes, overheadRes, hoursRes, byAccountRes, docRes] = await Promise.all([
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
    // Unbilled cost documents use markup; project charges carry an explicit
    // independently snapshotted bill amount.
    db.execute(sql`
      select coalesce(sum(case when d.kind = 'project_charge' then coalesce(dl.bill_amount, 0)
                               else dl.amount * coalesce(nullif(dl.cost_multiplier, 0), 1) end), 0) as bill,
             coalesce(sum(dl.amount), 0) as cost, count(*) as cnt
        from document_lines dl join documents d on d.id = dl.document_id
       where dl.org_id = ${orgId} and dl.project_id = ${projectId}
         and dl.is_billable and dl.billed_by_line_id is null
         and ((d.kind = 'project_charge' and d.status in ('approved','posted'))
           or (d.status = 'posted' and d.kind in ('vendor_bill','expense_report','card_charge','check')))`),
    // laborCost — resolved per profile source (payroll JE / time rate / group).
    profile.laborCost.source === 'payroll_je'
      ? db.execute(sql`select coalesce(sum(l.amount), 0) as labor from journal_lines l join journal_entries e on e.id = l.entry_id
           where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted' and e.origin = 'labor_burden'`)
      : profile.laborCost.source === 'time_rate'
        ? db.execute(sql`select coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as labor from time_entries te
             where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'`)
        : db.execute(sql`select 0 as labor`),
    // overhead (account_group_actual only) — posted GL to overhead accounts.
    profile.overhead.method !== 'account_group_actual'
      ? db.execute(sql`select 0 as overhead`)
      : db.execute(sql`select coalesce(sum(l.amount) filter (where ${costPredicate(overheadCostSource, overheadIds)}), 0) as overhead
           from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
          where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted'`),
    // project approved labor hours (base for per-hour / rate-engine overhead).
    db.execute(sql`select coalesce(sum(te.hours), 0) as total,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billed
        from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'`),
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
  const totalHours = n(hoursRes.rows[0]?.total)
  // Overhead is a STATISTICAL allocation (never a GL posting by default). Each
  // method turns a rate into the job's share of company overhead.
  const oh = profile.overhead
  const overhead =
    oh.method === 'account_group_actual' ? n(overheadRes.rows[0]?.overhead)
    : oh.method === 'percent_of_labor' ? laborCost * ((oh.ratePercent ?? 0) / 100)
    : oh.method === 'per_labor_hour' ? totalHours * (oh.ratePerHour ?? 0)
    : oh.method === 'rate_engine' ? await rateEngineOverhead(orgId, projectId, oh.rateEngine)
    : 0

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
  const componentSum: Record<string, number> = { actual_cost: actualCost, committed_cost: committedCost, labor_cost: profile.laborCost.source === 'in_actual_cost' ? 0 : laborCost, overhead }
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
    overhead,
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
