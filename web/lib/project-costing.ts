import 'server-only'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { db, orgContext, pool } from '@openbooks/engine/src/db.ts'
import { add, fromUnits, neg, normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'
import { directSubcontractOpenCommitment } from './subcontract-commitments'

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

interface QueryRows<T> { rows: T[] }
interface ProjectSummaryRow { contract_value: unknown; cost_budget: unknown }
interface ProjectActualRow { cost: unknown; revenue: unknown }
interface ProjectCommittedRow { committed_cost: unknown; committed_revenue: unknown }
interface ProjectAccountRow { account_id: string; number: string | null; name: string; type: string; amount: unknown }
interface ProjectDocumentRow {
  id: string; kind: string; document_number: string; document_date: string;
  status: string; party_name: string | null; amount: unknown
}
interface ProjectTimeSqlRow {
  key: string | null; label: string; hours: unknown; billable_hours: unknown;
  cost: unknown; bill: unknown
}

/**
 * Resolve the summary against the database surface provided by the ambient
 * tenant context. The public function below owns the transaction boundary;
 * keeping the read graph here lets an existing caller transaction participate
 * without opening a second transaction on the same connection.
 */
async function projectCostSummaryInSnapshot(
  orgId: string,
  projectId: string,
): Promise<ProjectCostSummary> {
  const [proj, actualRows, committedRows, directSubcontractCommitment, byAccountRows, docRows] = await Promise.all([
    // project custom (contract value) + task cost budget
    db.execute(sql`
      select coalesce(p.contract_value, 0) as contract_value,
             coalesce((select sum(t.estimated_cost) from project_tasks t where t.project_id = p.id and t.org_id = p.org_id), 0) as cost_budget
        from projects p where p.id = ${projectId} and p.org_id = ${orgId}
    `),
    // posted actuals split into cost vs revenue
    db.execute(sql`
      select
        coalesce(sum(l.amount) filter (where a.type in ${COST_SET}), 0) as cost,
        coalesce(-sum(l.amount) filter (where a.type in ${REVENUE_SET}), 0) as revenue
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')
    `),
    // committed: open order remainders tagged to the project
    db.execute(sql`
      select
        coalesce(sum((dl.quantity - dl.quantity_billed) * dl.unit_price) filter (where d.kind = 'purchase_order'), 0) as committed_cost,
        coalesce(sum((dl.quantity - dl.quantity_billed) * dl.unit_price) filter (where d.kind = 'sales_order'), 0) as committed_revenue
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      where dl.org_id = ${orgId}
        and coalesce(dl.project_id, d.project_id) = ${projectId}
        and d.status = 'approved' and d.kind in ('purchase_order', 'sales_order')
        and dl.quantity > dl.quantity_billed
    `),
    directSubcontractOpenCommitment(orgId, projectId),
    // actual cost broken down by account
    db.execute(sql`
      select a.id as account_id, a.number, a.name, a.type, sum(l.amount) as amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status in ('posted', 'reversed')
        and a.type in ${COST_SET}
      group by a.id, a.number, a.name, a.type
      having sum(l.amount) <> 0
      order by sum(l.amount) desc
    `),
    // documents with at least one line tagged to the project (job cost detail)
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status,
             pt.display_name as party_name,
             sum(dl.amount) as amount
      from documents d
      join document_lines dl
        on dl.document_id = d.id
       and dl.org_id = d.org_id
       and coalesce(dl.project_id, d.project_id) = ${projectId}
      left join parties pt on pt.id = d.party_id and pt.org_id = d.org_id
      where d.org_id = ${orgId}
      group by d.id, d.kind, d.document_number, d.document_date, d.status, pt.display_name
      order by d.document_date desc
      limit 500
    `),
  ])

  return assembleSummary(
    proj as unknown as QueryRows<ProjectSummaryRow>,
    actualRows as unknown as QueryRows<ProjectActualRow>,
    committedRows as unknown as QueryRows<ProjectCommittedRow>,
    directSubcontractCommitment,
    byAccountRows as unknown as QueryRows<ProjectAccountRow>,
    docRows as unknown as QueryRows<ProjectDocumentRow>,
  )
}

/**
 * Resolve a project's cost rollup as one committed ledger generation.
 *
 * The headline totals, committed amounts, account breakdown, and source
 * documents are independent statements. Running them as pooled READ COMMITTED
 * queries allows a posting or order update to land between statements and
 * produce a response whose totals disagree with its own detail. Pin a
 * REPEATABLE READ READ ONLY snapshot so every field observes the same ledger
 * generation. If a caller already owns a tenant transaction, participate in
 * that transaction instead of opening a nested transaction on its connection.
 *
 * The transaction is published through the tenant context so
 * `directSubcontractOpenCommitment` (and any future helper) resolves its `db`
 * queries on this same connection and snapshot.
 */
export async function projectCostSummary(orgId: string, projectId: string): Promise<ProjectCostSummary> {
  const active = orgContext.getStore()
  if (active?.txDb && !active.bypass) {
    if (orgId !== active.orgId) {
      throw new Error('cannot change organization inside an active tenant transaction')
    }
    return projectCostSummaryInSnapshot(orgId, projectId)
  }

  const client = await pool.connect()
  try {
    await client.query('begin isolation level repeatable read read only')
    // Scope this transaction after BEGIN so the tenant setting is local to the
    // snapshot and resets when the client is committed or rolled back.
    await client.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
      [orgId],
    )
    const txDb = drizzle({ client })
    const summary = await orgContext.run({ orgId, bypass: false, txDb }, async () =>
      await projectCostSummaryInSnapshot(orgId, projectId),
    )
    await client.query('commit')
    return summary
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // A broken connection is discarded when released.
    }
    throw error
  } finally {
    client.release()
  }
}

function assembleSummary(
  proj: QueryRows<ProjectSummaryRow>,
  actualRows: QueryRows<ProjectActualRow>,
  committedRows: QueryRows<ProjectCommittedRow>,
  directSubcontractCommitment: string,
  byAccountRows: QueryRows<ProjectAccountRow>,
  docRows: QueryRows<ProjectDocumentRow>,
): ProjectCostSummary {
  const p = proj.rows[0] ?? { contract_value: 0, cost_budget: 0 }
  const contractValue = m(p.contract_value)
  const costBudget = m(p.cost_budget)
  const cost = m(actualRows.rows[0]?.cost)
  const revenue = m(actualRows.rows[0]?.revenue)
  const committedCost = add(m(committedRows.rows[0]?.committed_cost), directSubcontractCommitment)
  const committedRevenue = m(committedRows.rows[0]?.committed_revenue)

  const costByAccount = byAccountRows.rows.map((r) => ({
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
    documents: docRows.rows.map((r) => ({
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
  byItem: ProjectTimeRow[]
  totals: { hours: number; billableHours: number; cost: string; bill: string }
}

/**
 * Approved labor tagged to a project, rolled up by employee, service item, and
 * WBS task plus totals. Cost = Σ hours × cost_rate; bill value = Σ hours ×
 * bill_rate; billableHours counts only is_billable entries. Every summary row
 * is keyed by the same dimension stored on the underlying time entry so the
 * project drawer can drill back to its canonical records without reconstructing
 * membership from display labels.
 */
export async function projectTimeSummary(orgId: string, projectId: string): Promise<ProjectTimeSummary> {
  const [byTaskRows, byEmpRows, byItemRows, totalRow] = await Promise.all([
    db.execute(sql`
      select te.project_task_id as key, coalesce(pt.name, '') as label,
             coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as cost,
             coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4)), 0) as bill
        from time_entries te
        left join project_tasks pt
          on pt.id = te.project_task_id and pt.org_id = te.org_id and pt.project_id = te.project_id
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
       group by te.project_task_id, pt.name
       order by hours desc
    `),
    db.execute(sql`
      select te.employee_party_id as key, coalesce(pty.display_name, '') as label,
             coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as cost,
             coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4)), 0) as bill
        from time_entries te
        left join parties pty on pty.id = te.employee_party_id and pty.org_id = te.org_id
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
       group by te.employee_party_id, pty.display_name
       order by hours desc
    `),
    db.execute(sql`
      select te.item_id as key, coalesce(i.name, '') as label,
             coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as cost,
             coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4)), 0) as bill
        from time_entries te
        left join items i on i.id = te.item_id and i.org_id = te.org_id
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
       group by te.item_id, i.name
       order by hours desc
    `),
    db.execute(sql`
      select coalesce(sum(te.hours), 0) as hours,
             coalesce(sum(te.hours) filter (where te.is_billable), 0) as billable_hours,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0) as cost,
             coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4)), 0) as bill
        from time_entries te
       where te.org_id = ${orgId} and te.project_id = ${projectId} and te.status = 'approved'
    `),
  ])
  const row = (r: ProjectTimeSqlRow): ProjectTimeRow => ({
    key: r.key,
    label: r.label || '',
    hours: n(r.hours),
    billableHours: n(r.billable_hours),
    cost: m(r.cost),
    bill: m(r.bill),
  })
  const tot = totalRow.rows[0] ?? {}
  return {
    byTask: (byTaskRows.rows as unknown as ProjectTimeSqlRow[]).map(row),
    byEmployee: (byEmpRows.rows as unknown as ProjectTimeSqlRow[]).map(row),
    byItem: (byItemRows.rows as unknown as ProjectTimeSqlRow[]).map(row),
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
    `),
    db.execute(sql`
      select coalesce(sum(case when d.kind = 'project_charge' then coalesce(dl.bill_amount, 0)
                               else dl.amount * coalesce(nullif(dl.cost_multiplier, 0), 1) end), 0) as revenue,
             coalesce(sum(dl.amount), 0) as cost,
             count(*) as cnt
        from document_lines dl
        join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and coalesce(dl.project_id, d.project_id) = ${projectId}
         and dl.is_billable and dl.billed_by_line_id is null
         and ((d.kind = 'project_charge' and d.status in ('approved','posted'))
           or (d.status = 'posted' and d.kind in ('vendor_bill', 'expense_report', 'card_charge', 'check')))
    `),
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
