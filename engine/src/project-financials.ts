import { sql, type SQL } from 'drizzle-orm'
import { db } from './db.ts'
import type { FinancialProfile, CostSource, OverheadSource } from '@openbooks/schema'
import { resolveAccountGroups } from './account-groups.ts'
import { add, cmp, fromUnits, mul, mulPercent, neg, normalizeMoney, roundDiv, sum, toUnits } from './money.ts'
import { directSubcontractOpenCommitment } from './subcontract-commitments.ts'

/**
 * Profile-driven project financials — the configurable successor to the hardcoded
 * measures in `project-costing.ts`. Given a project type's `FinancialProfile`, it
 * resolves the full measure catalog (base aggregations + derived formulas) so the
 * Financials P&L renders per type. Monetary measures stay exact decimal strings
 * through the entire calculation and are covered by deterministic parity tests.
 */

const amount = (v: unknown): string => normalizeMoney(v == null ? '0' : String(v))

export interface ProjectFinancials {
  /** measure key → dollar value (marginPct is a percentage, not dollars). */
  measures: Record<string, string | number>
  costByCategory: { category: string; amount: string }[]
  costByAccount: { accountId: string; number: string | null; name: string; amount: string }[]
  documents: { id: string; kind: string; documentNumber: string; documentDate: string; status: string; partyName: string | null; amount: string }[]
  projectType: string | null
  contractValue: string
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
 * rate_engine overhead — per-department hourly rates applied to the project's
 * labor: overhead = Σ ( hours × the rate effective on each entry's work date ).
 *
 * Rates come ONLY from the published, effective-dated rate card
 * (overhead_rates). The Overhead Model's live composite is an analytical
 * preview that seeds publishing — it is never a costing basis, so project costs
 * and closed-period margins can never restate retroactively. A department's
 * rate is the SUM of its effective rows (a card may stack category rows);
 * per_hour rows cost hours × $rate, percent rows cost labor cost × rate%.
 * Purely statistical — no GL posting.
 */
async function rateEngineOverhead(
  orgId: string,
  projectId: string,
  cfg: OverheadSource['rateEngine'],
): Promise<string> {
  const basis = cfg?.hoursBasis ?? 'total_hours'
  const r = (await db.execute<{ overhead: string }>(sql`
    select coalesce(sum(round(
             case when o.rate_kind = 'percent'
                  then te.hours * coalesce(te.cost_rate, 0) * o.rate_percent / 100
                  else te.hours * o.rate_percent end,
             4
           )), 0) as overhead
      from time_entries te
      join overhead_rates o on o.department_id = te.department_id
        and te.worked_on >= o.effective_from
        and (o.effective_to is null or te.worked_on <= o.effective_to)
        and o.org_id = ${orgId}
     where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
       ${basis === 'billed_hours'
         ? sql`and te.is_billable`
         : basis === 'actual_hours'
           ? sql`and te.costing_basis = 'actual'`
           : sql``}`))
  return amount(r.rows[0]?.overhead)
}

async function overheadAdjustments(
  orgId: string,
  projectId: string,
): Promise<string> {
  const r = (await db.execute<{ adjustment: string }>(sql`
    select coalesce(sum(amount), 0) as adjustment
      from project_overhead_adjustments
     where org_id = ${orgId} and project_id = ${projectId}
  `))
  return amount(r.rows[0]?.adjustment)
}

type AdjustableMeasure =
  | 'actual_cost'
  | 'invoiced_to_date'
  | 'billable_value'
  | 'total_price'
  | 'could_be_invoiced'
  | 'gross_profit'

async function projectFinancialAdjustments(
  orgId: string,
  projectId: string,
): Promise<Record<AdjustableMeasure, string>> {
  const result = (await db.execute<{ measure: AdjustableMeasure; amount: string }>(sql`
    select measure, coalesce(sum(amount), 0) as amount
      from project_financial_adjustments
     where org_id = ${orgId} and project_id = ${projectId}
     group by measure
  `))
  const adjustments: Record<AdjustableMeasure, string> = {
    actual_cost: '0.0000',
    invoiced_to_date: '0.0000',
    billable_value: '0.0000',
    total_price: '0.0000',
    could_be_invoiced: '0.0000',
    gross_profit: '0.0000',
  }
  for (const row of result.rows) adjustments[row.measure] = amount(row.amount)
  return adjustments
}

export async function resolveProjectFinancials(
  orgId: string,
  projectId: string,
  profile: FinancialProfile,
): Promise<ProjectFinancials> {
  // Project header (contract value + markup + billing method).
  const projRow = (await db.execute<{ contract_value: string; markup_percent: string; project_type: string | null; cost_budget: string }>(sql`
    select coalesce(p.contract_value, 0) as contract_value,
           coalesce((p.custom->>'markupPercent')::numeric, 0) as markup_percent,
           coalesce(pt.key, 'time_and_materials') as project_type,
           coalesce((select sum(t.estimated_cost) from project_tasks t where t.project_id = p.id and t.org_id = p.org_id), 0) as cost_budget
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.id = ${projectId} and p.org_id = ${orgId}
  `))
  const proj = projRow.rows[0] ?? { contract_value: '0', markup_percent: '0', project_type: null, cost_budget: '0' }
  const contractValue = amount(proj.contract_value)
  const projectMarkupPercent = amount(proj.markup_percent)
  const costBudget = profile.costBudget.source === 'wbs_estimates' ? amount(proj.cost_budget) : '0.0000'

  // Account-id sets for account-group cost sources. Overhead only reads GL when
  // its method is posted_gl_account_group; every other method is a
  // statistical rate applied below (never a GL sum).
  const overheadCostSource: CostSource =
    profile.overhead.method === 'posted_gl_account_group' && profile.overhead.accountGroup
      ? { source: 'account_group', dimension: profile.overhead.accountGroup.dimension, groupKeys: profile.overhead.accountGroup.groupKeys }
      : { source: 'none' }
  const [costIds, overheadIds] = await Promise.all([
    groupAccountIds(orgId, profile.actualCost),
    groupAccountIds(orgId, overheadCostSource),
  ])
  const financialAdjustmentsPromise = projectFinancialAdjustments(
    orgId,
    projectId,
  )
  const directSubcontractCommitmentPromise = directSubcontractOpenCommitment(
    orgId,
    projectId,
  )

  const invoiceKinds = profile.invoicedToDate.docKinds
  const creditKinds = profile.invoicedToDate.creditKinds
  const kindList = (ks: string[]) => sql.join(ks.map((k) => sql`${k}`), sql`, `)
  const committedKinds = profile.committedCost.docKinds
  const committedStatuses = profile.committedCost.statuses ?? ['approved']
  const billableCostKinds = profile.billableValue.costSourceKinds?.length
    ? profile.billableValue.costSourceKinds
    : ['vendor_bill', 'expense_report', 'card_charge', 'check']
  const billableCostStatuses =
    profile.billableValue.costSourceStatuses ?? ['approved', 'posted']

  const [invRes, costRes, committedRes, billableTimeRes, billableLineRes, laborRes, overheadRes, hoursRes, byAccountRes, docRes] = await Promise.all([
    // invoicedToDate — effective line tagging (line override, then header
    // inheritance), matching the posting kernel's dimension semantics.
    db.execute(sql`
      select coalesce(sum(dl.amount) filter (where d.kind in (${kindList(invoiceKinds)})), 0)
           - coalesce(sum(dl.amount) filter (where d.kind in (${kindList(creditKinds.length ? creditKinds : ['__none__'])})), 0) as invoiced
        from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and coalesce(dl.project_id, d.project_id) = ${projectId}
         and d.status = 'posted'
         and d.kind in (${kindList([...invoiceKinds, ...creditKinds])})`),
    // actualCost + revenuePosted — posted GL tagged to the project.
    db.execute(sql`
      select coalesce(sum(l.amount) filter (where ${costPredicate(profile.actualCost, costIds)}), 0) as cost,
             coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0) as revenue
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id and a.org_id = l.org_id
       where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')`),
    // committedCost — unbilled portion (by line amount) of open (approved)
    // orders. Uses amount × unbilled-fraction rather than qty×unit_price, since
    // migrated orders often carry the amount but no per-unit price.
    db.execute(sql`
      select coalesce(sum(
               case when d.kind = 'project_charge'
                    then coalesce(dl.cost_amount, dl.amount)
                    else round(
                      (case when d.kind = 'vendor_credit'
                            then -dl.amount else dl.amount end)
                      * case when coalesce(dl.quantity,0) > 0
                        then greatest(0, (dl.quantity - coalesce(dl.quantity_billed,0)) / dl.quantity)
                        else 1
                      end,
                      4
                    )
               end
             ), 0) as committed
        from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and coalesce(dl.project_id, d.project_id) = ${projectId}
         and d.status in (${kindList(committedStatuses.length ? committedStatuses : ['__none__'])})
         and (
           d.kind = 'project_charge'
           or (
             d.kind in (${kindList(committedKinds.length ? committedKinds : ['__none__'])})
             and (coalesce(dl.quantity,0) = 0 or dl.quantity_billed is null or dl.quantity_billed < dl.quantity)
           )
         )`),
    // Billable time is selling-value evidence independent of invoice amount.
    // Fixed/progress invoices often have no one-to-one time-line relationship,
    // so total price cannot be reconstructed as invoice + unbilled time.
    db.execute(sql`
      select coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4)), 0) as total_bill,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as total_cost,
             coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4))
               filter (where te.billing_status = 'unbilled'), 0) as unbilled_bill,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4))
               filter (where te.billing_status = 'unbilled'), 0) as unbilled_cost
       from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId}
         and te.status = 'approved' and te.is_billable`),
    // Billable cost is likewise all eligible work, with its unbilled subset
    // retained separately for invoicing/backlog presentation.
    db.execute(sql`
      select coalesce(sum(
               case
                 when d.kind = 'project_charge' then coalesce(dl.bill_amount, 0)
                 when dl.bill_amount is not null then
                   case when d.kind = 'vendor_credit'
                        then -dl.bill_amount else dl.bill_amount end
                 else
                   round(
                     (case when d.kind = 'vendor_credit'
                           then -dl.amount else dl.amount end)
                     * case when dl.markup_percent is not null
                            then 1 + dl.markup_percent / 100
                            else coalesce(nullif(dl.cost_multiplier, 0), 1)
                       end,
                     4
                   )
               end
             ), 0) as total_bill,
             coalesce(sum(
               case when d.kind = 'vendor_credit'
                    then -dl.amount else dl.amount end
             ), 0) as total_cost,
             coalesce(sum(
               case
                 when d.kind = 'project_charge' then coalesce(dl.bill_amount, 0)
                 when dl.bill_amount is not null then
                   case when d.kind = 'vendor_credit'
                        then -dl.bill_amount else dl.bill_amount end
                 else
                   round(
                     (case when d.kind = 'vendor_credit'
                           then -dl.amount else dl.amount end)
                     * case when dl.markup_percent is not null
                            then 1 + dl.markup_percent / 100
                            else coalesce(nullif(dl.cost_multiplier, 0), 1)
                       end,
                     4
                   )
               end
             ) filter (where dl.billed_by_line_id is null), 0) as unbilled_bill,
             coalesce(sum(
               case when d.kind = 'vendor_credit'
                    then -dl.amount else dl.amount end
             )
               filter (where dl.billed_by_line_id is null), 0) as unbilled_cost
        from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and coalesce(dl.project_id, d.project_id) = ${projectId}
         and dl.is_billable
         and d.status in (${kindList(billableCostStatuses.length ? billableCostStatuses : ['__none__'])})
         and (d.kind = 'project_charge'
           or d.kind in (${kindList(billableCostKinds.length ? billableCostKinds : ['__none__'])}))`),
    // laborCost — resolved per profile source (payroll JE / time rate / group).
    profile.laborCost.source === 'payroll_je'
      ? db.execute(sql`select coalesce(sum(l.amount), 0) as labor from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed') and e.origin = 'labor_burden'`)
      : profile.laborCost.source === 'time_rate'
        ? db.execute(sql`select coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as labor from time_entries te
             where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'`)
        : profile.laborCost.source === 'estimated_time_rate'
          ? db.execute(sql`select coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as labor from time_entries te
               where te.org_id = ${orgId} and te.project_id = ${projectId}
                 and te.status = 'approved' and te.costing_basis = 'estimated'`)
        : db.execute(sql`select 0 as labor`),
    // overhead (posted_gl_account_group only) — posted GL to overhead accounts.
    profile.overhead.method !== 'posted_gl_account_group'
      ? db.execute(sql`select 0 as overhead`)
      : db.execute(sql`select coalesce(sum(l.amount) filter (where ${costPredicate(overheadCostSource, overheadIds)}), 0) as overhead
           from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id join accounts a on a.id = l.account_id and a.org_id = l.org_id
          where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')`),
    // project approved labor hours (base for per-hour / rate-engine overhead).
    db.execute(sql`select coalesce(sum(te.hours), 0) as total,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billed
        from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'`),
    // cost by account (for the breakdown subtab) — same cost predicate.
    db.execute<any>(sql`
      select a.id as account_id, a.number, a.name, a.type, coalesce(sum(l.amount), 0) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')
         and ${costPredicate(profile.actualCost, costIds)}
       group by a.id, a.number, a.name, a.type having coalesce(sum(l.amount),0) <> 0 order by amount desc`),
    // documents on the project (transactions tab).
    db.execute<any>(sql`
      select d.id, d.kind, d.document_number as "documentNumber", d.document_date::text as "documentDate",
             d.status, pt.display_name as "partyName",
             case when d.kind = 'project_charge'
                  then coalesce(sum(coalesce(dl.bill_amount, dl.amount)), 0)
                  else coalesce(sum(dl.amount), 0)
              end as amount
        from documents d
        left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
        left join parties pt on pt.id = d.party_id and pt.org_id = d.org_id
       where d.org_id = ${orgId}
         and coalesce(dl.project_id, d.project_id) = ${projectId}
       group by d.id, pt.display_name order by d.document_date desc, d.document_number desc`),
  ])

  const [adjustments, directSubcontractCommitment] = await Promise.all([
    financialAdjustmentsPromise,
    directSubcontractCommitmentPromise,
  ])
  const invoicedToDate = add(
    amount(invRes.rows[0]?.invoiced),
    adjustments.invoiced_to_date,
  )
  const actualCost = add(
    amount(costRes.rows[0]?.cost),
    adjustments.actual_cost,
  )
  const revenuePosted = amount(costRes.rows[0]?.revenue)
  const committedCost = add(
    amount(committedRes.rows[0]?.committed),
    directSubcontractCommitment,
  )
  const laborCost = amount(laborRes.rows[0]?.labor)
  const totalHours = amount(hoursRes.rows[0]?.total)
  // Overhead is a STATISTICAL allocation (never a GL posting by default). Each
  // method turns a rate into the job's share of company overhead.
  const oh = profile.overhead
  const calculatedOverhead =
    oh.method === 'posted_gl_account_group' ? amount(overheadRes.rows[0]?.overhead)
    : oh.method === 'percent_of_labor' ? mulPercent(laborCost, String(oh.ratePercent ?? 0))
    : oh.method === 'per_labor_hour' ? mul(totalHours, String(oh.ratePerHour ?? 0))
    : oh.method === 'rate_engine' ? await rateEngineOverhead(orgId, projectId, oh.rateEngine)
    : '0.0000'
  const overheadAdjustment = oh.method === 'none'
    ? '0.0000'
    : await overheadAdjustments(orgId, projectId)
  const overhead = add(calculatedOverhead, overheadAdjustment)

  // billable value: what's invoiceable across all work (time + cost lines).
  const totalTimeBill = profile.billableValue.timeRate === 'cost_times_markup'
    ? add(amount(billableTimeRes.rows[0]?.total_cost), mulPercent(amount(billableTimeRes.rows[0]?.total_cost), projectMarkupPercent))
    : amount(billableTimeRes.rows[0]?.total_bill)
  const totalLineBill = profile.billableValue.timeRate === 'cost_times_markup'
    ? add(amount(billableLineRes.rows[0]?.total_cost), mulPercent(amount(billableLineRes.rows[0]?.total_cost), projectMarkupPercent))
    : amount(billableLineRes.rows[0]?.total_bill)
  const unbTimeBill = profile.billableValue.includeUnbilledTime
    ? (profile.billableValue.timeRate === 'cost_times_markup'
        ? add(amount(billableTimeRes.rows[0]?.unbilled_cost), mulPercent(amount(billableTimeRes.rows[0]?.unbilled_cost), projectMarkupPercent))
        : amount(billableTimeRes.rows[0]?.unbilled_bill))
    : '0.0000'
  const unbLineBill = profile.billableValue.includeUnbilledCostLines
    ? (profile.billableValue.timeRate === 'cost_times_markup'
        ? add(amount(billableLineRes.rows[0]?.unbilled_cost), mulPercent(amount(billableLineRes.rows[0]?.unbilled_cost), projectMarkupPercent))
        : amount(billableLineRes.rows[0]?.unbilled_bill))
    : '0.0000'
  const unbilledBillable = add(unbTimeBill, unbLineBill)
  const billableValue = add(
    add(totalTimeBill, totalLineBill),
    adjustments.billable_value,
  )

  // total cost: only the configured components (labor stays inside actual_cost
  // unless split out, avoiding double count).
  const componentSum: Record<string, string> = { actual_cost: actualCost, committed_cost: committedCost, labor_cost: profile.laborCost.source === 'in_actual_cost' ? '0.0000' : laborCost, overhead }
  const totalCost = sum(profile.totalCost.components.map((key) => componentSum[key] ?? '0.0000'))

  // total price by method.
  let totalPrice: string
  switch (profile.totalPrice.method) {
    case 'contract_field': totalPrice = contractValue; break
    case 'billable_value': totalPrice = billableValue; break
    case 'not_to_exceed': totalPrice = cmp(contractValue, '0') > 0 && cmp(contractValue, billableValue) < 0 ? contractValue : billableValue; break
    case 'cost_plus': {
      const markupPercent = profile.totalPrice.defaultMarkupPercent != null && cmp(projectMarkupPercent, '0') === 0
        ? String(profile.totalPrice.defaultMarkupPercent)
        : projectMarkupPercent
      totalPrice = add(totalCost, mulPercent(totalCost, markupPercent))
      break
    }
    default: totalPrice = contractValue
  }
  totalPrice = add(totalPrice, adjustments.total_price)

  const calculatedCouldBeInvoiced = profile.couldBeInvoiced.formula === 'price_minus_invoiced'
    ? add(totalPrice, neg(invoicedToDate))
    : unbilledBillable
  const couldBeInvoiced = add(
    calculatedCouldBeInvoiced,
    adjustments.could_be_invoiced,
  )
  const calculatedGrossProfit = add(totalPrice, neg(totalCost))
  const grossProfit = add(calculatedGrossProfit, adjustments.gross_profit)
  const totalPriceUnits = toUnits(totalPrice)
  const marginPct = totalPriceUnits !== 0n
    ? Number(fromUnits(roundDiv(
        toUnits(grossProfit) * 100n * 10_000n * (totalPriceUnits < 0n ? -1n : 1n),
        totalPriceUnits < 0n ? -totalPriceUnits : totalPriceUnits,
      )))
    : 0
  const remainingBudget = add(costBudget, neg(totalCost))

  const measures: Record<string, string | number> = {
    invoiced_to_date: invoicedToDate,
    revenue_posted: revenuePosted,
    actual_cost: actualCost,
    actual_cost_adjustment: adjustments.actual_cost,
    invoiced_to_date_adjustment: adjustments.invoiced_to_date,
    labor_cost: laborCost,
    calculated_overhead: calculatedOverhead,
    overhead_adjustment: overheadAdjustment,
    overhead,
    committed_cost: committedCost,
    billable_value: billableValue,
    billable_value_adjustment: adjustments.billable_value,
    billable_time_value: totalTimeBill,
    billable_cost_value: totalLineBill,
    unbilled_billable: unbilledBillable,
    cost_budget: costBudget,
    total_price: totalPrice,
    total_price_adjustment: adjustments.total_price,
    could_be_invoiced: couldBeInvoiced,
    could_be_invoiced_adjustment: adjustments.could_be_invoiced,
    total_cost: totalCost,
    gross_profit: grossProfit,
    gross_profit_adjustment: adjustments.gross_profit,
    margin_pct: marginPct,
    remaining_budget: remainingBudget,
  }

  const costByCategory = new Map<string, string>()
  for (const r of byAccountRes.rows) {
    const cat = r.type === 'cogs' ? 'cogs' : 'operating_expense'
    costByCategory.set(cat, add(costByCategory.get(cat) ?? '0.0000', amount(r.amount)))
  }

  return {
    measures,
    costByCategory: [...costByCategory].map(([category, amount]) => ({ category, amount })),
    costByAccount: byAccountRes.rows.map((r) => ({ accountId: r.account_id, number: r.number, name: r.name, amount: amount(r.amount) })),
    documents: docRes.rows.map((r) => ({ id: r.id, kind: r.kind, documentNumber: r.documentNumber, documentDate: r.documentDate, status: r.status, partyName: r.partyName, amount: amount(r.amount) })),
    projectType: proj.project_type,
    contractValue,
  }
}
