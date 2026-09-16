import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, neg, normalizeMoney } from '@openbooks/engine/src/money.ts'
import { subsidiaryVisibleFilter } from './subsidiaries'

/**
 * Set-based job-cost ranking across MANY projects — the portfolio view that
 * `projectCostSummary` (one project, full detail) deliberately does not
 * provide. One statement answers "which jobs are losing money", "which are
 * over budget", "largest fixed-price contracts": the caller gets a total
 * count, the ranked page, and per-row budget / actual / committed / margin so
 * the assistant never has to walk projects one call at a time.
 *
 * Same accounting basis as the single-project summary: posted+reversed lines
 * in the primary posting book, cost = debit balance of cost-type accounts,
 * revenue = credit balance of income-type accounts, committed cost = open
 * approved purchase-order remainder. Direct subcontract commitments (a
 * per-project helper) are intentionally excluded here — the detail call
 * includes them and says so.
 */

const COST_TYPES = ['expense', 'cogs', 'expense_other', 'expense_deferred']
const REVENUE_TYPES = ['income', 'income_other']

export const PROJECT_RANK_SORTS = [
  'margin_asc',
  'margin_desc',
  'margin_percent_asc',
  'cost_desc',
  'revenue_desc',
  'contract_value_desc',
  'over_budget_desc',
  'unbilled_contract_desc',
] as const
export type ProjectRankSort = (typeof PROJECT_RANK_SORTS)[number]

export interface ProjectRankingArgs {
  statuses?: readonly string[]
  billingMethod?: string
  query?: string
  customerQuery?: string
  negativeMarginOnly?: boolean
  overBudgetOnly?: boolean
  /** Drop projects with neither posted cost nor posted revenue (default true). */
  withActivityOnly?: boolean
  sort?: ProjectRankSort
  limit: number
  offset?: number
}

export interface ProjectRankingRow {
  id: string
  code: string | null
  name: string
  status: string
  customer: string | null
  projectType: string | null
  billingMethod: string | null
  contractValue: string
  costBudget: string
  cost: string
  revenue: string
  margin: string
  /** margin ÷ revenue × 100 at two decimals; null when there is no revenue. */
  marginPercent: number | null
  committedCost: string
  /** cost + committed − cost budget; positive = over budget (null without a budget). */
  budgetOverrun: string | null
  /** contract value − posted revenue; what remains to bill on a fixed contract. */
  unbilledContract: string
}

export interface ProjectRanking {
  total: number
  rows: ProjectRankingRow[]
}

const m = (v: unknown) => normalizeMoney(v == null ? '0' : String(v))

function orderBy(sort: ProjectRankSort): SQL {
  switch (sort) {
    case 'margin_desc':
      return sql`margin desc, name`
    case 'margin_percent_asc':
      return sql`(case when revenue = 0 then null else margin / revenue end) asc nulls last, margin asc, name`
    case 'cost_desc':
      return sql`cost desc, name`
    case 'revenue_desc':
      return sql`revenue desc, name`
    case 'contract_value_desc':
      return sql`contract_value desc, name`
    case 'over_budget_desc':
      return sql`(case when cost_budget > 0 then cost + committed_cost - cost_budget else null end) desc nulls last, name`
    case 'unbilled_contract_desc':
      return sql`(contract_value - revenue) desc, name`
    case 'margin_asc':
    default:
      return sql`margin asc, name`
  }
}

export async function rankProjects(
  orgId: string,
  args: ProjectRankingArgs,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<ProjectRanking> {
  const limit = Math.max(1, Math.min(args.limit, 100))
  const offset = Math.max(0, args.offset ?? 0)
  const sort = args.sort ?? 'margin_asc'
  const like = args.query ? `%${args.query}%` : null
  const customerLike = args.customerQuery ? `%${args.customerQuery}%` : null
  const statuses = args.statuses?.length ? args.statuses : null
  const withActivityOnly = args.withActivityOnly ?? true

  const costSet = sql`(${sql.join(COST_TYPES.map((t) => sql`${t}`), sql`, `)})`
  const revenueSet = sql`(${sql.join(REVENUE_TYPES.map((t) => sql`${t}`), sql`, `)})`
  const projectScope = subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)
  const lineScope = subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowedSubsidiaryIds)

  const res = await db.execute<Record<string, unknown>>(sql`
    with book as (
      select b.id from accounting_books b
       where b.org_id = ${orgId} and b.is_primary and b.is_active and b.posts_gl
       limit 1
    ),
    scoped as (
      select p.id, p.code, p.name, p.status, coalesce(p.contract_value, 0) as contract_value,
             c.display_name as customer, pt.name as project_type, pt.billing_method
        from projects p
        left join parties c on c.id = p.customer_id and c.org_id = p.org_id
        left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
       where p.org_id = ${orgId}${projectScope}
         ${statuses ? sql`and p.status in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
         ${args.billingMethod ? sql`and pt.billing_method = ${args.billingMethod}` : sql``}
         ${like ? sql`and (p.name ilike ${like} or p.code ilike ${like})` : sql``}
         ${customerLike ? sql`and c.display_name ilike ${customerLike}` : sql``}
    ),
    -- Classify by account-id SETS rather than joining accounts per line: the
    -- planner otherwise drives from accounts and probes every line.
    cost_accounts as (
      select id from accounts where org_id = ${orgId} and type in ${costSet}
    ),
    revenue_accounts as (
      select id from accounts where org_id = ${orgId} and type in ${revenueSet}
    ),
    actuals as (
      select l.project_id,
             coalesce(sum(l.amount) filter (where l.account_id in (select id from cost_accounts)), 0) as cost,
             coalesce(-sum(l.amount) filter (where l.account_id in (select id from revenue_accounts)), 0) as revenue
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${orgId}
         and l.project_id in (select id from scoped)
         and e.status in ('posted', 'reversed')
         and e.book_id = (select id from book)
         ${lineScope}
       group by l.project_id
    ),
    budget as (
      select t.project_id, coalesce(sum(t.estimated_cost), 0) as cost_budget
        from project_tasks t
       where t.org_id = ${orgId} and t.project_id in (select id from scoped)
       group by t.project_id
    ),
    committed as (
      select coalesce(dl.project_id, d.project_id) as project_id,
             coalesce(sum(round((dl.quantity - dl.quantity_billed) * dl.unit_price * d.fx_rate, 4)), 0) as committed_cost
        from document_lines dl
        join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and d.status = 'approved' and d.kind = 'purchase_order'
         and dl.quantity > dl.quantity_billed
         and coalesce(dl.project_id, d.project_id) in (select id from scoped)
       group by 1
    ),
    ranked as (
      select s.id, s.code, s.name, s.status, s.customer, s.project_type, s.billing_method,
             s.contract_value,
             coalesce(b.cost_budget, 0) as cost_budget,
             coalesce(a.cost, 0) as cost,
             coalesce(a.revenue, 0) as revenue,
             coalesce(a.revenue, 0) - coalesce(a.cost, 0) as margin,
             coalesce(cm.committed_cost, 0) as committed_cost
        from scoped s
        left join actuals a on a.project_id = s.id
        left join budget b on b.project_id = s.id
        left join committed cm on cm.project_id = s.id
    )
    select *, count(*) over () as total
      from ranked
     where true
       ${withActivityOnly ? sql`and (cost <> 0 or revenue <> 0)` : sql``}
       ${args.negativeMarginOnly ? sql`and margin < 0` : sql``}
       ${args.overBudgetOnly ? sql`and cost_budget > 0 and cost + committed_cost > cost_budget` : sql``}
     order by ${orderBy(sort)}
     limit ${limit} offset ${offset}
  `)

  const rows = res.rows.map((r): ProjectRankingRow => {
    const revenue = m(r.revenue)
    const margin = m(r.margin)
    const costBudget = m(r.cost_budget)
    const cost = m(r.cost)
    const committed = m(r.committed_cost)
    const contractValue = m(r.contract_value)
    const revenueNum = Number(revenue)
    return {
      id: String(r.id),
      code: r.code == null ? null : String(r.code),
      name: String(r.name),
      status: String(r.status),
      customer: r.customer == null ? null : String(r.customer),
      projectType: r.project_type == null ? null : String(r.project_type),
      billingMethod: r.billing_method == null ? null : String(r.billing_method),
      contractValue,
      costBudget,
      cost,
      revenue,
      margin,
      marginPercent: revenueNum === 0 ? null : Math.round((Number(margin) / revenueNum) * 10000) / 100,
      committedCost: committed,
      budgetOverrun: Number(costBudget) > 0 ? add(add(cost, committed), neg(costBudget)) : null,
      unbilledContract: add(contractValue, neg(revenue)),
    }
  })
  return { total: Number(res.rows[0]?.total ?? 0), rows }
}
