import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { fiscalYearRange } from './reports'
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

export async function budgetScenarioOptions(): Promise<BudgetScenarioOption[]> {
  const r = (await db.execute(sql`
    select id, name, fiscal_year, kind, status
      from budget_scenarios
     order by fiscal_year desc, name
  `)) as unknown as { rows: { id: string; name: string; fiscal_year: number; kind: string; status: string }[] }
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
  leaf: Map<string, [number, number]>,
): { id: string; number: string | null; name: string; type: string; depth: number; isSummary: boolean; values: number[] }[] {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rolled = new Map<string, [number, number]>(accounts.map((a) => [a.id, [...(leaf.get(a.id) ?? [0, 0])] as [number, number]]))
  for (const a of accounts) {
    const own = leaf.get(a.id)
    if (!own) continue
    let p = a.parent_id
    while (p) {
      const acc = rolled.get(p)
      if (acc) {
        acc[0] += own[0]
        acc[1] += own[1]
      }
      p = byId.get(p)?.parent_id ?? null
    }
  }
  const children = new Map<string | null, Acct[]>()
  for (const a of accounts) {
    if (!children.has(a.parent_id)) children.set(a.parent_id, [])
    children.get(a.parent_id)!.push(a)
  }
  const out: { id: string; number: string | null; name: string; type: string; depth: number; isSummary: boolean; values: number[] }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      const raw = rolled.get(a.id) ?? [0, 0]
      const flip = CREDIT_NORMAL.has(a.type)
      const values = [flip ? -raw[0] : raw[0], flip ? -raw[1] : raw[1]]
      if (values.some((v) => Math.abs(v) >= 0.005) || a.is_summary) {
        out.push({ id: a.id, number: a.number, name: a.name, type: a.type, depth, isSummary: a.is_summary, values })
      }
      walk(a.id, depth + 1)
    }
  }
  walk(null, 0)
  return out.filter((r, i) => {
    if (!r.isSummary || r.values.some((v) => Math.abs(v) >= 0.005)) return true
    const next = out[i + 1]
    return next !== undefined && next.depth > r.depth
  })
}

/** Build a Budget vs Actual statement view for a scenario, or null if unknown. */
export async function budgetVsActualView(scenarioId: string, labels: BudgetLabels): Promise<StatementView | null> {
  const sc = (await db.execute(sql`
    select id, book_id, fiscal_year, name from budget_scenarios where id = ${scenarioId}
  `)) as unknown as { rows: { id: string; book_id: string; fiscal_year: number; name: string }[] }
  const scenario = sc.rows[0]
  if (!scenario) return null
  const fy = await fiscalYearRange(scenario.fiscal_year)

  const actualRows = (await db.execute(sql`
    select l.account_id, coalesce(sum(l.amount), 0) as amt
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where a.type in ${PNL_TYPES} and e.book_id = ${scenario.book_id}
       and e.posting_date >= ${fy.from} and e.posting_date <= ${fy.to}
     group by l.account_id
  `)) as unknown as { rows: { account_id: string; amt: string }[] }

  const budgetRows = (await db.execute(sql`
    select bl.account_id, coalesce(sum(bl.amount), 0) as amt
      from budget_lines bl
     where bl.scenario_id = ${scenarioId}
     group by bl.account_id
  `)) as unknown as { rows: { account_id: string; amt: string }[] }

  const accounts = (await db.execute(sql`
    select id, parent_id, number, name, type, is_summary
      from accounts where type in ${PNL_TYPES}
     order by number nulls last, name
  `)) as unknown as { rows: Acct[] }

  const leaf = new Map<string, [number, number]>()
  for (const r of actualRows.rows) leaf.set(r.account_id, [Number(r.amt), 0])
  for (const r of budgetRows.rows) {
    const cur = leaf.get(r.account_id) ?? [0, 0]
    cur[1] = Number(r.amt)
    leaf.set(r.account_id, cur)
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
      values: recomputeVariance({ columns, rows: [], truncated: false }, [...r.values, 0, 0]),
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
  const section = (title: string, types: string[], total: number[]) => {
    lines.push({ kind: 'section', label: title, depth: 0 })
    lines.push(...accountLines(types))
    lines.push({ kind: 'subtotal', label: labels.totalOf(title), depth: 0, values: total, drillTypes: types })
  }
  section(labels.revenue, revenueTypes, revenue)
  section(labels.costOfGoodsSold, cogsTypes, cogs)
  lines.push({ kind: 'subtotal', label: labels.grossProfit, depth: 0, emphasis: true, values: grossProfit })
  section(labels.expenses, expenseTypes, expenses)
  lines.push({ kind: 'total', label: labels.netIncome, depth: 0, emphasis: true, values: netIncome })

  return { columns, lines, truncated: false, hasVariance: true, mode: 'flow' }
}
