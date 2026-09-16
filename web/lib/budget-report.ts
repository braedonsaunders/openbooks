import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, mulDecimal } from '@openbooks/engine/src/money.ts'
import { flowRates } from './fx-presentation'
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
    // A malformed imported cycle must terminate, not hang the report (same
    // policy as the statement treeify rollups).
    const seen = new Set<string>([a.id])
    let p = a.parent_id
    while (p && !seen.has(p)) {
      seen.add(p)
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

/**
 * Build a Budget vs Actual statement view for a scenario, or null if unknown.
 *
 * Both columns share ONE caller-resolved window, exactly like the P&L: actuals
 * sum posted lines with `from <= posting_date <= to`, and budget sums the
 * scenario lines whose accounting period overlaps the same window. Callers
 * resolve the window through the shared period machinery (`resolvePeriod`),
 * so the report filter bar's period is the single source of truth — without
 * it the whole fiscal year leaked future-dated actuals into a "year to date"
 * comparison the P&L never showed. Omitting `period` keeps the legacy
 * whole-fiscal-year window.
 */
export async function budgetVsActualView(
  scenarioId: string,
  orgId: string,
  labels: BudgetLabels,
  dims: Partial<BudgetDimensions> = {},
  subsidiaryIds?: readonly string[],
  period?: { from: string; to: string },
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
  // The resolved window, echoed on the Actual column below: P&L parity holds
  // if and only if both readers aggregate this same range.
  const window = period ?? fy

  const subsidiaryList = subsidiaryIds?.length ? sql.join(subsidiaryIds.map((id) => sql`${id}::uuid`), sql`, `) : sql`null`
  // Both columns arrive per (account, functional): journal legs are stamped
  // in their line entity's functional and budget lines read in their
  // subsidiary's functional (subsidiary-keyed amounts with no currency
  // column, like gl_month_activity). Each leg translates to the org
  // presentation currency at its latest date before the caller merges them
  // per account — the same second leg every consolidated flow reader applies.
  const actualRows = (await db.execute<{ account_id: string; func: string | null; amt: string; late: string | null }>(sql`
    select l.account_id, sub.base_currency as func, coalesce(sum(l.amount), 0) as amt,
      max(e.posting_date)::text as late
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
     where e.org_id = ${orgId} and a.org_id = ${orgId}
       and a.type in ${PNL_TYPES} and e.book_id = ${scenario.book_id}
       ${subsidiaryIds ? sql`and l.subsidiary_id in (${subsidiaryList})` : sql``}
       and e.posting_date >= ${window.from} and e.posting_date <= ${window.to}
       ${dims.departmentId ? sql`and l.department_id = ${dims.departmentId}` : sql``}
       ${dims.projectId ? sql`and l.project_id = ${dims.projectId}` : sql``}
       ${dims.locationId ? sql`and l.location_id = ${dims.locationId}` : sql``}
       ${dims.classId ? sql`and l.class_id = ${dims.classId}` : sql``}
     group by l.account_id, sub.base_currency
  `))

  const budgetRows = (await db.execute<{ account_id: string; func: string | null; amt: string; late: string | null }>(sql`
    select bl.account_id, sub.base_currency as func, coalesce(sum(bl.amount), 0) as amt,
      max(ap.ends_on)::text as late
      from budget_lines bl
      left join accounting_periods ap on ap.id = bl.period_id and ap.org_id = bl.org_id
      left join subsidiaries sub on sub.id = bl.subsidiary_id and sub.org_id = bl.org_id
     where bl.org_id = ${orgId} and bl.scenario_id = ${scenarioId}
       and (ap.id is null or (ap.starts_on <= ${window.to} and ap.ends_on >= ${window.from}))
       ${subsidiaryIds ? sql`and bl.subsidiary_id in (${subsidiaryList})` : sql``}
       ${dims.departmentId ? sql`and bl.department_id = ${dims.departmentId}` : sql``}
       ${dims.projectId ? sql`and bl.project_id = ${dims.projectId}` : sql``}
       ${dims.locationId ? sql`and bl.location_id = ${dims.locationId}` : sql``}
       ${dims.classId ? sql`and bl.class_id = ${dims.classId}` : sql``}
     group by bl.account_id, sub.base_currency
  `))

  const actualCtx = await flowRates(orgId, actualRows.rows.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? window.to).slice(0, 10),
  })))
  const actualByAccount = new Map<string, string>()
  for (const r of actualRows.rows) {
    const date = String(r.late ?? window.to).slice(0, 10)
    actualByAccount.set(
      r.account_id,
      add(actualByAccount.get(r.account_id) ?? '0', mulDecimal(String(r.amt ?? 0), actualCtx.rateAt(r.func ?? null, date))),
    )
  }
  const budgetCtx = await flowRates(orgId, budgetRows.rows.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? window.to).slice(0, 10),
  })))
  const budgetByAccount = new Map<string, string>()
  for (const r of budgetRows.rows) {
    const date = String(r.late ?? window.to).slice(0, 10)
    budgetByAccount.set(
      r.account_id,
      add(budgetByAccount.get(r.account_id) ?? '0', mulDecimal(String(r.amt ?? 0), budgetCtx.rateAt(r.func ?? null, date))),
    )
  }

  const accounts = (await db.execute<Acct>(sql`
    select id, parent_id, number, name, type, is_summary
      from accounts where org_id = ${orgId} and type in ${PNL_TYPES}
     order by number nulls last, name
  `))

  const leaf = new Map<string, [ExactDecimal, ExactDecimal]>()
  for (const [accountId, amt] of actualByAccount) leaf.set(accountId, [amt as ExactDecimal, '0.0000'])
  for (const [accountId, amt] of budgetByAccount) {
    const cur = leaf.get(accountId) ?? ['0.0000', '0.0000']
    cur[1] = amt as ExactDecimal
    leaf.set(accountId, cur as [ExactDecimal, ExactDecimal])
  }

  const treeRows = treeify(accounts.rows, leaf)

  const columns: StatementColumn[] = [
    // Only the Actual column drills to ledger transactions (from/to = the
    // resolved window); Budget comes from budget_lines, not the ledger, so
    // it carries no drill window — but it aggregates the same window.
    { key: 'actual', label: labels.actual, kind: 'amount', from: window.from, to: window.to },
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
