import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { BudgetDimensions } from './budgets'
import {
  sumSection,
  combineTotals,
  recomputeVariance,
  PNL_TYPES,
  type StatementColumn,
  type StatementMatrix,
  type StatementView,
  type StatementViewLine,
} from './statement-matrix'
import {
  decimalAdd,
  decimalIsMaterial,
  decimalNeg,
  type ExactDecimal,
  type StatementValue,
} from './statement-format'

/**
 * Budget vs Actual. Budget data is dimensional like the ledger (account ×
 * period × book × dims — schema/src/planning.ts), so a scenario's budget and
 * the posted actuals for the same fiscal year and book roll up the SAME account
 * tree. We build a 4-column matrix (Actual, Budget, Variance $, Variance %) and
 * reuse the shared section/total assembly from statement-matrix.ts.
 *
 * Sign convention matches the P&L: credit-normal income is flipped so revenue
 * reads positive; expenses read positive. Variance = Actual − Budget.
 */

const CREDIT_NORMAL = new Set(['income', 'income_other'])

export type BudgetScenarioOption = {
  id: string
  name: string
  fiscalYear: number
  kind: string
  status: string
}

export async function budgetScenarioOptions(orgId: string): Promise<BudgetScenarioOption[]> {
  const r = (await db.execute<{ id: string; name: string; fiscal_year: number; kind: string; status: string }>(sql`
    select id, name, fiscal_year, kind, status
      from budget_scenarios
     where org_id = ${orgId} and status <> 'archived'
     order by fiscal_year desc, name
  `))
  return r.rows.map((x) => ({ id: x.id, name: x.name, fiscalYear: x.fiscal_year, kind: x.kind, status: x.status }))
}

export type BudgetLabels = {
  actual: string
  budget: string
  variance: string
  variancePct: string
  revenue: string
  costOfGoodsSold: string
  grossProfit: string
  expenses: string
  netIncome: string
  totalOf: (section: string) => string
}

type Acct = {
  id: string
  parent_id: string | null
  number: string | null
  name: string
  type: string
  is_summary: boolean
}

/** Roll a [actual, budget] leaf vector up the account tree, reader-signed. */
function treeify(
  accounts: Acct[],
  leaf: Map<string, [ExactDecimal, ExactDecimal]>,
): { id: string; number: string | null; name: string; type: string; depth: number; isSummary: boolean; values: ExactDecimal[] }[] {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rolled = new Map<string, [ExactDecimal, ExactDecimal]>(
    accounts.map((a) => [a.id, [...(leaf.get(a.id) ?? ['0.0000', '0.0000'])] as [ExactDecimal, ExactDecimal]]),
  )
  for (const a of accounts) {
    const own = leaf.get(a.id)
    if (!own) continue
    let p = a.parent_id
    while (p) {
      const acc = rolled.get(p)
      if (acc) {
        acc[0] = decimalAdd(acc[0], own[0])
        acc[1] = decimalAdd(acc[1], own[1])
      }
      p = byId.get(p)?.parent_id ?? null
    }
  }
  const children = new Map<string | null, Acct[]>()
  for (const a of accounts) {
    if (!children.has(a.parent_id)) children.set(a.parent_id, [])
    children.get(a.parent_id)!.push(a)
  }
  const out: { id: string; number: string | null; name: string; type: string; depth: number; isSummary: boolean; values: ExactDecimal[] }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      const raw = rolled.get(a.id) ?? ['0.0000', '0.0000']
      const flip = CREDIT_NORMAL.has(a.type)
      const values = [flip ? decimalNeg(raw[0]) : raw[0], flip ? decimalNeg(raw[1]) : raw[1]]
      if (values.some((v) => decimalIsMaterial(v)) || a.is_summary) {
        out.push({ id: a.id, number: a.number, name: a.name, type: a.type, depth, isSummary: a.is_summary, values })
      }
      walk(a.id, depth + 1)
    }
  }
  walk(null, 0)
  return out.filter((r, i) => {
    if (!r.isSummary || r.values.some((v) => decimalIsMaterial(v))) return true
    const next = out[i + 1]
    return next !== undefined && next.depth > r.depth
  })
}

/** Build a Budget vs Actual statement view for a scenario, or null if unknown. */
export async function budgetVsActualView(
  scenarioId: string,
  orgId: string,
  labels: BudgetLabels,
  dims: Partial<BudgetDimensions> = {},
): Promise<StatementView | null> {
  const sc = (await db.execute<{ id: string; book_id: string; fiscal_year: number; name: string }>(sql`
    select id, book_id, fiscal_year, name from budget_scenarios where id = ${scenarioId} and org_id = ${orgId}
  `))
  const scenario = sc.rows[0]
  if (!scenario) return null
  const periodRange = (await db.execute<{ from: string | null; to: string | null }>(sql`
    select min(starts_on)::text as "from", max(ends_on)::text as "to"
      from accounting_periods
     where org_id = ${orgId} and fiscal_year = ${scenario.fiscal_year} and not is_adjustment
  `))
  const range = periodRange.rows[0]
  if (!range?.from || !range?.to) return null
  const fy = { from: range.from, to: range.to }

  const actualRows = (await db.execute<{ account_id: string; amt: string }>(sql`
    select l.account_id, coalesce(sum(l.amount), 0) as amt
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where e.org_id = ${orgId} and a.org_id = ${orgId}
       and a.type in ${PNL_TYPES} and e.book_id = ${scenario.book_id}
       and e.posting_date >= ${fy.from} and e.posting_date <= ${fy.to}
       ${dims.departmentId ? sql`and l.department_id = ${dims.departmentId}` : sql``}
       ${dims.projectId ? sql`and l.project_id = ${dims.projectId}` : sql``}
       ${dims.locationId ? sql`and l.location_id = ${dims.locationId}` : sql``}
       ${dims.classId ? sql`and l.class_id = ${dims.classId}` : sql``}
     group by l.account_id
  `))

  const budgetRows = (await db.execute<{ account_id: string; amt: string }>(sql`
    select bl.account_id, coalesce(sum(bl.amount), 0) as amt
      from budget_lines bl
     where bl.org_id = ${orgId} and bl.scenario_id = ${scenarioId}
       ${dims.departmentId ? sql`and bl.department_id = ${dims.departmentId}` : sql``}
       ${dims.projectId ? sql`and bl.project_id = ${dims.projectId}` : sql``}
       ${dims.locationId ? sql`and bl.location_id = ${dims.locationId}` : sql``}
       ${dims.classId ? sql`and bl.class_id = ${dims.classId}` : sql``}
     group by bl.account_id
  `))

  const accounts = (await db.execute<Acct>(sql`
    select id, parent_id, number, name, type, is_summary
      from accounts where org_id = ${orgId} and type in ${PNL_TYPES}
     order by number nulls last, name
  `))

  const leaf = new Map<string, [ExactDecimal, ExactDecimal]>()
  for (const r of actualRows.rows) leaf.set(r.account_id, [String(r.amt), '0.0000'])
  for (const r of budgetRows.rows) {
    const cur = leaf.get(r.account_id) ?? ['0.0000', '0.0000']
    cur[1] = String(r.amt)
    leaf.set(r.account_id, cur as [ExactDecimal, ExactDecimal])
  }

  const treeRows = treeify(accounts.rows, leaf)

  const columns: StatementColumn[] = [
    // Only the Actual column drills to ledger transactions (from/to = the FY);
    // Budget comes from budget_lines, not the ledger, so it carries no window.
    { key: 'actual', label: labels.actual, kind: 'amount', from: fy.from, to: fy.to },
    { key: 'budget', label: labels.budget, kind: 'amount' },
    { key: 'var_abs', label: labels.variance, kind: 'variance_abs' },
    { key: 'var_pct', label: labels.variancePct, kind: 'variance_pct' },
  ]
  const matrix: StatementMatrix = {
    columns,
    rows: treeRows.map((r) => ({
      id: r.id,
      number: r.number,
      name: r.name,
      type: r.type,
      depth: r.depth,
      isSummary: r.isSummary,
      values: recomputeVariance({ columns, rows: [], truncated: false }, [...r.values, '0.0000', '0.0000']),
    })),
    truncated: false,
  }

  const revenueTypes = ['income', 'income_other']
  const cogsTypes = ['cogs']
  const expenseTypes = ['expense', 'expense_other', 'expense_deferred']
  const revenue = sumSection(matrix, revenueTypes)
  const cogs = sumSection(matrix, cogsTypes)
  const expenses = sumSection(matrix, expenseTypes)
  const grossProfit = combineTotals(matrix, [revenue, cogs], [1, -1])
  const netIncome = combineTotals(matrix, [revenue, cogs, expenses], [1, -1, -1])

  const lines: StatementViewLine[] = []
  const accountLines = (types: string[]): StatementViewLine[] =>
    matrix.rows
      .filter((r) => types.includes(r.type))
      .map((r) => ({ kind: 'account' as const, label: r.name, number: r.number, accountId: r.id, depth: r.depth, emphasis: r.isSummary, values: r.values }))
  const section = (title: string, types: string[], total: StatementValue[]) => {
    lines.push({ kind: 'section', label: title, depth: 0 })
    lines.push(...accountLines(types))
    lines.push({ kind: 'subtotal', label: labels.totalOf(title), depth: 0, values: total, drillTypes: types })
  }
  section(labels.revenue, revenueTypes, revenue)
  section(labels.costOfGoodsSold, cogsTypes, cogs)
  lines.push({ kind: 'subtotal', label: labels.grossProfit, depth: 0, emphasis: true, values: grossProfit, drillTypes: [...revenueTypes, ...cogsTypes] })
  section(labels.expenses, expenseTypes, expenses)
  lines.push({ kind: 'total', label: labels.netIncome, depth: 0, emphasis: true, values: netIncome, drillTypes: PNL_TYPES })

  return { columns, lines, truncated: false, hasVariance: true, mode: 'flow' }
}
