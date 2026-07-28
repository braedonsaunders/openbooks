import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, fromUnits, neg, normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'

/**
 * Job-costing rollup for a single project — the heart of project accounting.
 *
 * Pulls four layers together against one project (job):
 *   • Budget      — cost budget from the WBS task estimates + a contract value
 *                   (revenue budget) stored on the project.
 *   • Actual      — posted GL activity tagged to the project. Cost = the debit
 *                   balance of expense/COGS accounts; revenue = the credit
 *                   balance of income accounts (amount sign: debit +, credit −).
 *   • Committed   — open purchase-order remainder (ordered, not yet billed) is
 *                   committed COST; open sales-order remainder is committed
 *                   REVENUE / backlog. This is what turns a ledger into a job
 *                   forecast: Budget vs (Actual + Committed) vs Remaining.
 *   • Breakdown   — actual cost by GL account and by coarse category, plus the
 *                   source documents tagged to the job.
 *
 * All money remains canonical decimal strings through every calculation.
 */

// GL account types (see accounts.type) that count as job COST vs REVENUE.
const COST_TYPES = ['expense', 'cogs', 'expense_other', 'expense_deferred']
const REVENUE_TYPES = ['income', 'income_other']

const COST_SET = sql`(${sql.join(COST_TYPES.map((t) => sql`${t}`), sql`, `)})`
const REVENUE_SET = sql`(${sql.join(REVENUE_TYPES.map((t) => sql`${t}`), sql`, `)})`

export interface ProjectCostSummary {
  budget: { cost: string; contractValue: string }
  actual: { cost: string; revenue: string; margin: string }
  committed: { cost: string; revenue: string }
  /** Budget vs (actual + committed). */
  forecast: { projectedCost: string; remainingBudget: string; percentSpent: number | null }
  costByAccount: { accountId: string; number: string | null; name: string; type: string; amount: string }[]
  /** `category` is a stable code ('cogs' | 'operating_expense') — render sites translate it. */
  costByCategory: { category: string; amount: string }[]
  documents: {
    id: string
    kind: string
    documentNumber: string
    documentDate: string
    status: string
    partyName: string | null
    amount: string
  }[]
}

const m = (v: unknown) => normalizeMoney(v == null ? '0' : String(v))
const n = (v: unknown) => (v == null ? 0 : Number(v))

export async function projectCostSummary(orgId: string, projectId: string): Promise<ProjectCostSummary> {
  const [proj, actualRows, committedRows, byAccountRows, docRows] = await Promise.all([
    // project custom (contract value) + task cost budget
    db.execute(sql`
      select coalesce(p.contract_value, 0) as contract_value,
             coalesce((select sum(t.estimated_cost) from project_tasks t where t.project_id = p.id), 0) as cost_budget
        from projects p where p.id = ${projectId} and p.org_id = ${orgId}
    `) as any,
    // posted actuals split into cost vs revenue
    db.execute(sql`
      select
        coalesce(sum(l.amount) filter (where a.type in ${COST_SET}), 0) as cost,
        coalesce(-sum(l.amount) filter (where a.type in ${REVENUE_SET}), 0) as revenue
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')
    `) as any,
    // committed: open order remainders tagged to the project
    db.execute(sql`
      select
        coalesce(sum((dl.quantity - dl.quantity_billed) * dl.unit_price) filter (where d.kind = 'purchase_order'), 0) as committed_cost,
        coalesce(sum((dl.quantity - dl.quantity_billed) * dl.unit_price) filter (where d.kind = 'sales_order'), 0) as committed_revenue
      from document_lines dl
      join documents d on d.id = dl.document_id
      where dl.org_id = ${orgId} and dl.project_id = ${projectId}
        and d.status = 'approved' and d.kind in ('purchase_order', 'sales_order')
        and dl.quantity > dl.quantity_billed
    `) as any,
    // actual cost broken down by account
    db.execute(sql`
      select a.id as account_id, a.number, a.name, a.type, sum(l.amount) as amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')
        and a.type in ${COST_SET}
      group by a.id, a.number, a.name, a.type
      having sum(l.amount) <> 0
      order by sum(l.amount) desc
    `) as any,
    // documents with at least one line tagged to the project (job cost detail)
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status,
             pt.display_name as party_name,
             sum(dl.amount) as amount
      from documents d
      join document_lines dl on dl.document_id = d.id and dl.project_id = ${projectId}
      left join parties pt on pt.id = d.party_id
      where d.org_id = ${orgId}
      group by d.id, d.kind, d.document_number, d.document_date, d.status, pt.display_name
      order by d.document_date desc
      limit 500
    `) as any,
  ])

  return assembleSummary(proj, actualRows, committedRows, byAccountRows, docRows)
}

function assembleSummary(proj: any, actualRows: any, committedRows: any, byAccountRows: any, docRows: any): ProjectCostSummary {
  const p = proj.rows[0] ?? { contract_value: 0, cost_budget: 0 }
  const contractValue = m(p.contract_value)
  const costBudget = m(p.cost_budget)
  const cost = m(actualRows.rows[0]?.cost)
  const revenue = m(actualRows.rows[0]?.revenue)
  const committedCost = m(committedRows.rows[0]?.committed_cost)
  const committedRevenue = m(committedRows.rows[0]?.committed_revenue)

  const costByAccount = (byAccountRows.rows as any[]).map((r) => ({
    accountId: r.account_id,
    number: r.number,
    name: r.name,
    type: r.type,
    amount: m(r.amount),
  }))
  const catMap = new Map<string, string>()
  for (const r of costByAccount) {
    const cat = r.type === 'cogs' ? 'cogs' : 'operating_expense'
    catMap.set(cat, add(catMap.get(cat) ?? '0', r.amount))
  }
  const costByCategory = [...catMap.entries()].map(([category, amount]) => ({ category, amount }))

  const projectedCost = add(cost, committedCost)
  const costBudgetUnits = toUnits(costBudget)
  return {
    budget: { cost: costBudget, contractValue },
    actual: { cost, revenue, margin: add(revenue, neg(cost)) },
    committed: { cost: committedCost, revenue: committedRevenue },
    forecast: {
      projectedCost,
      remainingBudget: add(costBudget, neg(projectedCost)),
      percentSpent: costBudgetUnits > 0n
        ? Number(fromUnits((toUnits(projectedCost) * 10_000n) / costBudgetUnits))
        : null,
    },
    costByAccount,
    costByCategory,
    documents: (docRows.rows as any[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      documentNumber: r.document_number,
      documentDate: r.document_date,
      status: r.status,
      partyName: r.party_name,
      amount: m(r.amount),
    })),
  }
}

/* ------------------------------------------------------------------ */
/* Time summary — labor hours/cost/bill by task and by employee        */
/* ------------------------------------------------------------------ */

export interface ProjectTimeRow {
  key: string | null
  label: string
  hours: number
  billableHours: number
  cost: string
  bill: string
}

export interface ProjectTimeSummary {
  byTask: ProjectTimeRow[]
  byEmployee: ProjectTimeRow[]
  totals: { hours: number; billableHours: number; cost: string; bill: string }
}

/**
 * Approved labor tagged to a project, rolled up two ways (by WBS task and by
 * employee) plus totals. Cost = Σ hours × cost_rate; bill value = Σ hours ×
 * bill_rate; billableHours counts only is_billable entries. This is the labor
 * surface the cockpit's Cost & Time tab renders — the atom of job costing that
 * was previously invisible on the project view.
 */
export async function projectTimeSummary(orgId: string, projectId: string): Promise<ProjectTimeSummary> {
  const [byTaskRows, byEmpRows, totalRow] = await Promise.all([
    db.execute(sql`
      select te.project_task_id as key, coalesce(pt.name, '') as label,
             coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as cost,
             coalesce(sum(te.hours * coalesce(te.bill_rate, 0)), 0) as bill
        from time_entries te
        left join project_tasks pt on pt.id = te.project_task_id
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
       group by te.project_task_id, pt.name
       order by hours desc
    `) as any,
    db.execute(sql`
      select te.employee_party_id as key, coalesce(pty.display_name, '') as label,
             coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as cost,
             coalesce(sum(te.hours * coalesce(te.bill_rate, 0)), 0) as bill
        from time_entries te
        left join parties pty on pty.id = te.employee_party_id
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
       group by te.employee_party_id, pty.display_name
       order by hours desc
    `) as any,
    db.execute(sql`
      select coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as cost,
             coalesce(sum(te.hours * coalesce(te.bill_rate, 0)), 0) as bill
        from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
    `) as any,
  ])
  const row = (r: any): ProjectTimeRow => ({
    key: r.key,
    label: r.label || '',
    hours: n(r.hours),
    billableHours: n(r.billable_hours),
    cost: m(r.cost),
    bill: m(r.bill),
  })
  const tot = totalRow.rows[0] ?? {}
  return {
    byTask: (byTaskRows.rows as any[]).map(row),
    byEmployee: (byEmpRows.rows as any[]).map(row),
    totals: { hours: n(tot.hours), billableHours: n(tot.billable_hours), cost: m(tot.cost), bill: m(tot.bill) },
  }
}

/* ------------------------------------------------------------------ */
/* Unbilled — "available to bill" (source platform CouldBeInvoiced)           */
/* ------------------------------------------------------------------ */

export interface ProjectUnbilled {
  /** Billable value of work performed but not yet invoiced (bill rate / markup). */
  revenue: string
  /** Cost basis of that unbilled work. */
  cost: string
  hours: number
  timeEntryCount: number
  costLineCount: number
}

export interface UnbilledOpts {
  /** Restrict to time worked on/after this date (YYYY-MM-DD). */
  startDate?: string
  /** Restrict to time worked on/before this date (YYYY-MM-DD). */
  cutoffDate?: string
}

/**
 * "Available to bill" — the forward-looking figure the billing modal and cockpit
 * show, and the same rows the invoice generator consumes (so what you see is what
 * gets billed). Two sources, both provenance-gated so re-billing is safe:
 *   • approved billable time_entries not yet invoiced (invoiced_by_line_id null),
 *     valued at bill_rate (revenue) / cost_rate (cost);
 *   • billable cost lines on posted cost documents not yet billed
 *     (billed_by_line_id null), valued at amount × markup (cost_multiplier).
 * This is a statistical projection, NOT a ledger balance (see the WIP note in the
 * plan) — idempotency rests on the provenance columns, not this number.
 */
export async function projectUnbilled(orgId: string, projectId: string, opts: UnbilledOpts = {}): Promise<ProjectUnbilled> {
  const dateFilter = sql.join(
    [
      opts.startDate ? sql` and te.worked_on >= ${opts.startDate}` : sql``,
      opts.cutoffDate ? sql` and te.worked_on <= ${opts.cutoffDate}` : sql``,
    ],
    sql``,
  )
  const [timeRow, lineRow] = await Promise.all([
    db.execute(sql`
      select coalesce(sum(te.hours * coalesce(te.bill_rate, 0)), 0) as revenue,
             coalesce(sum(te.hours * coalesce(te.cost_rate, 0)), 0) as cost,
             coalesce(sum(te.hours), 0) as hours,
             count(*) as cnt
        from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId}
         and te.status = 'approved' and te.is_billable and te.billing_status = 'unbilled'${dateFilter}
    `) as any,
    db.execute(sql`
      select coalesce(sum(case when d.kind = 'project_charge' then coalesce(dl.bill_amount, 0)
                               else dl.amount * coalesce(nullif(dl.cost_multiplier, 0), 1) end), 0) as revenue,
             coalesce(sum(dl.amount), 0) as cost,
             count(*) as cnt
        from document_lines dl
        join documents d on d.id = dl.document_id
       where dl.org_id = ${orgId} and dl.project_id = ${projectId}
         and dl.is_billable and dl.billed_by_line_id is null
         and ((d.kind = 'project_charge' and d.status in ('approved','posted'))
           or (d.status = 'posted' and d.kind in ('vendor_bill', 'expense_report', 'card_charge', 'check')))
    `) as any,
  ])
  const tr = timeRow.rows[0] ?? {}
  const lr = lineRow.rows[0] ?? {}
  return {
    revenue: add(m(tr.revenue), m(lr.revenue)),
    cost: add(m(tr.cost), m(lr.cost)),
    hours: n(tr.hours),
    timeEntryCount: Number(tr.cnt ?? 0),
    costLineCount: Number(lr.cnt ?? 0),
  }
}
