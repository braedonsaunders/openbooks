import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { statementBookExpr } from "../gl-summary";
import { resolveOrgId } from "../org-scope";
import { decimalCmp, decimalSum, type ExactDecimal } from "../statement-format";
import { decimalRatio, decimalSubtract } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";

// ---------------------------------------------------------------------------
// Project profitability — per-project revenue, cost and margin (job costing)
// ---------------------------------------------------------------------------

export interface ProjectProfitRow {
  projectId: string
  projectName: string
  customerId: string | null
  customerName: string | null
  status: string | null
  projectType: string | null
  revenue: ExactDecimal
  cogs: ExactDecimal
  grossProfit: ExactDecimal
  expenses: ExactDecimal
  net: ExactDecimal
  margin: ExactDecimal | null // exact net ÷ revenue ratio; null when there's no revenue
  hours: number
}
export type ProjectProfitTotals = {
  revenue: ExactDecimal
  cogs: ExactDecimal
  grossProfit: ExactDecimal
  expenses: ExactDecimal
  net: ExactDecimal
  margin: ExactDecimal | null
  hours: number
}
export interface ProjectProfitCustomerGroup {
  customerId: string | null
  customerName: string | null
  rows: ProjectProfitRow[]
  totals: ProjectProfitTotals
}
export interface ProjectProfitResult {
  rows: ProjectProfitRow[]
  customers: ProjectProfitCustomerGroup[]
  totals: ProjectProfitTotals
  from: string
  to: string
}

function projectProfitTotals(rows: ProjectProfitRow[]): ProjectProfitTotals {
  const t = {
    revenue: decimalSum(rows.map((row) => row.revenue)),
    cogs: decimalSum(rows.map((row) => row.cogs)),
    grossProfit: decimalSum(rows.map((row) => row.grossProfit)),
    expenses: decimalSum(rows.map((row) => row.expenses)),
    net: decimalSum(rows.map((row) => row.net)),
    hours: rows.reduce((sum, row) => sum + row.hours, 0),
  }
  return { ...t, margin: decimalRatio(t.net, t.revenue) }
}

/** Customer subtotal hierarchy shared by the in-app report and every export. */
export function groupProjectProfitabilityRows(rows: ProjectProfitRow[]): ProjectProfitCustomerGroup[] {
  const grouped = new Map<string, ProjectProfitRow[]>()
  for (const row of rows) {
    const key = row.customerId ?? '__unassigned__'
    const group = grouped.get(key)
    if (group) group.push(row)
    else grouped.set(key, [row])
  }
  return [...grouped.values()]
    .map((customerRows) => ({
      customerId: customerRows[0]?.customerId ?? null,
      customerName: customerRows[0]?.customerName ?? null,
      rows: customerRows,
      totals: projectProfitTotals(customerRows),
    }))
    .sort((a, b) => decimalCmp(b.totals.net, a.totals.net) || (a.customerName ?? '').localeCompare(b.customerName ?? ''))
}

/**
 * Project profitability: for every project with posted P&L activity (or
 * approved time) in the period, its revenue, COGS, expenses, gross profit, net
 * and margin — reader-signed so revenue and profit read positive. Money comes
 * straight from `journal_lines.project_id`, so each project row ties exactly to
 * the same-book P&L filtered on that project (the row links there). `bookId`
 * selects the accounting book, defaulting to the org's primary book. `hours`
 * is approved `time_entries` for the period, an operational read on the money.
 */
export async function projectProfitability(
  from: string,
  to: string,
  opts: { dims?: DimFilter; customerId?: string; search?: string; projectScope?: 'active' | 'all'; orgId?: string; bookId?: string | null } = {},
): Promise<ProjectProfitResult> {
  const orgId = await resolveOrgId(opts.orgId)
  const r = (await db.execute<{
      id: string; name: string; customer_id: string | null; customer: string | null; status: string | null; project_type: string | null
      revenue: string; cogs: string; expenses: string; hours: string
    }>(sql`
    with pl as (
      select l.project_id,
             coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0) as revenue,
             coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0) as cogs,
             coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other','expense_deferred')), 0) as expenses
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
          and e.book_id = ${statementBookExpr(orgId, opts.bookId)}
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where l.project_id is not null
         and l.org_id = ${orgId}
         and e.posting_date >= ${from} and e.posting_date <= ${to}
         and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
         and ${dimWhere(opts.dims)}
       group by l.project_id
    ),
    hrs as (
      select project_id, coalesce(sum(hours), 0) as hours
        from time_entries
       where org_id = ${orgId} and project_id is not null and status = 'approved'
         and worked_on >= ${from} and worked_on <= ${to}
       group by project_id
    )
    select p.id, p.name, p.customer_id, cu.display_name as customer, p.status,
           coalesce(pt.key, 'time_and_materials') as project_type,
           coalesce(pl.revenue, 0) as revenue, coalesce(pl.cogs, 0) as cogs,
           coalesce(pl.expenses, 0) as expenses, coalesce(hrs.hours, 0) as hours
      from projects p
      left join pl on pl.project_id = p.id
      left join hrs on hrs.project_id = p.id
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
      left join parties cu on cu.id = p.customer_id and cu.org_id = p.org_id
     where p.org_id = ${orgId}
       and (pl.project_id is not null or hrs.project_id is not null)
       ${opts.projectScope === 'all' ? sql`` : sql`and p.is_active`}
       ${opts.customerId ? sql`and p.customer_id = ${opts.customerId}` : sql``}
       ${opts.search?.trim() ? sql`and (p.name ilike ${`%${opts.search.trim()}%`} or cu.display_name ilike ${`%${opts.search.trim()}%`})` : sql``}
     order by (coalesce(pl.revenue, 0) - coalesce(pl.cogs, 0) - coalesce(pl.expenses, 0)) desc, p.name
  `))
  const rows: ProjectProfitRow[] = r.rows.map((x) => {
    const revenue = x.revenue
    const cogs = x.cogs
    const expenses = x.expenses
    const grossProfit = decimalSubtract(revenue, cogs)
    const net = decimalSubtract(grossProfit, expenses)
    return {
      projectId: x.id,
      projectName: x.name,
      customerId: x.customer_id,
      customerName: x.customer,
      status: x.status,
      projectType: x.project_type,
      revenue, cogs, grossProfit, expenses, net,
      margin: decimalRatio(net, revenue),
      hours: Number(x.hours),
    }
  })
  return { rows, customers: groupProjectProfitabilityRows(rows), totals: projectProfitTotals(rows), from, to }
}

/** Customers that own at least one project, including historical/inactive rows. */
export async function projectProfitabilityCustomerOptions(orgId?: string): Promise<{ id: string; name: string }[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const result = (await db.execute<{ id: string; name: string }>(sql`
    select distinct cu.id, cu.display_name as name
      from projects p
      join parties cu on cu.id = p.customer_id and cu.org_id = p.org_id
     where p.org_id = ${resolvedOrgId}
     order by cu.display_name, cu.id
  `))
  return result.rows
}
