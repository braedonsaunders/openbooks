import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { addDays, addMonthsIso, fiscalMonthsBetween, fiscalQuartersBetween } from '@openbooks/reports'

/**
 * Multi-column statement engine. Where the legacy `accountBalances` returned a
 * single balance per account, this computes a VECTOR of values per account —
 * one per output column — in a single query using Postgres `sum() FILTER
 * (WHERE …)`. Columns come from the report's breakout (a column per
 * department / project / location / class, or per fiscal month / quarter) and
 * comparison (prior period / prior year + variance) settings, so a P&L can be
 * shown as a matrix. `treeifyMatrix` rolls each column up the account tree.
 *
 * Sign convention matches web/lib/reports.ts: journal amounts are debit-
 * positive; credit-normal types are flipped so revenue/liabilities/equity read
 * positive. Basis: accrual = every posted line; cash = only lines on entries
 * that also touch a bank account (mirrors the cash-flow contra logic).
 */

export type StatementBreakout =
  | 'none'
  | 'department'
  | 'project'
  | 'location'
  | 'class'
  | 'month'
  | 'quarter'
export type StatementCompare = 'none' | 'prior_period' | 'prior_year'
export type StatementBasis = 'accrual' | 'cash'
export type StatementMode = 'flow' | 'balance'

export type StatementDimFilter = {
  departmentId?: string
  projectId?: string
  locationId?: string
  classId?: string
}

export type StatementColumnKind = 'amount' | 'variance_abs' | 'variance_pct'
export type StatementColumn = {
  key: string
  label: string
  kind: StatementColumnKind
  /** Inclusive window the column covers (for headers/drill-through). */
  from?: string | null
  to?: string
}

export type MatrixRow = {
  id: string
  number: string | null
  name: string
  type: string
  depth: number
  isSummary: boolean
  /** Reader-signed values aligned to `columns`. */
  values: number[]
}

export type StatementMatrix = {
  columns: StatementColumn[]
  rows: MatrixRow[]
  /** True when breakout produced more dimension columns than the cap. */
  truncated: boolean
}

export const MAX_MATRIX_COLUMNS = 24

const CREDIT_NORMAL = new Set([
  'income',
  'income_other',
  'liability_payable',
  'liability_card',
  'liability_current_other',
  'liability_long_term',
  'equity',
])

const DIM_COLUMN: Record<string, string> = {
  department: 'department_id',
  project: 'project_id',
  location: 'location_id',
  class: 'class_id',
}
const DIM_TABLE: Record<string, string> = {
  department: 'departments',
  project: 'projects',
  location: 'locations',
  class: 'classes',
}

/** An amount column: a labelled date window with an optional dimension slice. */
type AmountColumn = {
  key: string
  label: string
  from: string | null
  to: string
  dimCol?: string
  dimVal?: string | null // null = the "Unassigned" bucket
}

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

/** Report-level dimension filter as a SQL fragment (AND-combined). */
function dimFilterSql(dims: StatementDimFilter | undefined): SQL {
  let w = sql`true`
  if (dims?.departmentId) w = sql`${w} and l.department_id = ${dims.departmentId}`
  if (dims?.projectId) w = sql`${w} and l.project_id = ${dims.projectId}`
  if (dims?.locationId) w = sql`${w} and l.location_id = ${dims.locationId}`
  if (dims?.classId) w = sql`${w} and l.class_id = ${dims.classId}`
  return w
}

/** One column's FILTER predicate: its date window + optional dimension slice. */
function columnPredicate(col: AmountColumn, mode: StatementMode): SQL {
  const date =
    mode === 'balance'
      ? sql`e.posting_date <= ${col.to}`
      : sql`e.posting_date >= ${col.from} and e.posting_date <= ${col.to}`
  if (!col.dimCol) return date
  const dimCol = sql.raw(`l.${col.dimCol}`)
  return col.dimVal === null
    ? sql`${date} and ${dimCol} is null`
    : sql`${date} and ${dimCol} = ${col.dimVal}`
}

/**
 * Build the amount columns for a report from its breakout + comparison.
 * Comparison columns are only added when there is a single base column
 * (breakout = none) — NetSuite's comparative statements are likewise single-
 * column plus a comparative amount.
 */
async function buildAmountColumns(opts: {
  mode: StatementMode
  period: { from: string; to: string }
  breakout: StatementBreakout
  compare: StatementCompare
  dims: StatementDimFilter | undefined
  periodLabel: string
}): Promise<{ cols: AmountColumn[]; truncated: boolean }> {
  const { mode, period, breakout, compare, dims, periodLabel } = opts

  if (breakout === 'month' || breakout === 'quarter') {
    const ranges =
      breakout === 'month'
        ? fiscalMonthsBetween(period.from, period.to)
        : fiscalQuartersBetween(period.from, period.to, 1)
    const capped = ranges.slice(0, MAX_MATRIX_COLUMNS)
    return {
      cols: capped.map((r) => ({ key: r.label, label: r.label, from: r.from, to: r.to })),
      truncated: ranges.length > capped.length,
    }
  }

  if (breakout !== 'none') {
    const table = DIM_TABLE[breakout]!
    const dimCol = DIM_COLUMN[breakout]!
    const periodWhere =
      mode === 'balance'
        ? sql`e.posting_date <= ${period.to}`
        : sql`e.posting_date >= ${period.from} and e.posting_date <= ${period.to}`
    const rows = (await db.execute(sql`
      select d.id, d.name
        from ${sql.raw(table)} d
       where exists (
         select 1 from journal_lines l
           join journal_entries e on e.id = l.entry_id
          where ${sql.raw(`l.${dimCol}`)} = d.id and ${periodWhere} and ${dimFilterSql(dims)}
       )
       order by d.name
    `)) as unknown as { rows: { id: string; name: string }[] }
    const unassigned = (await db.execute(sql`
      select 1 from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where ${sql.raw(`l.${dimCol}`)} is null and ${periodWhere} and ${dimFilterSql(dims)}
       limit 1
    `)) as unknown as { rows: unknown[] }
    const cols: AmountColumn[] = rows.rows.map((r) => ({
      key: r.id,
      label: r.name,
      from: period.from,
      to: period.to,
      dimCol,
      dimVal: r.id,
    }))
    if (unassigned.rows.length) {
      cols.push({ key: 'unassigned', label: 'Unassigned', from: period.from, to: period.to, dimCol, dimVal: null })
    }
    const capped = cols.slice(0, MAX_MATRIX_COLUMNS)
    return { cols: capped, truncated: cols.length > capped.length }
  }

  // breakout === 'none' — single base column, plus comparison.
  const base: AmountColumn = { key: 'current', label: periodLabel, from: period.from, to: period.to }
  if (compare === 'none') return { cols: [base], truncated: false }

  let prior: AmountColumn
  if (compare === 'prior_year') {
    prior = {
      key: 'prior',
      label: 'Prior year',
      from: addMonthsIso(period.from, -12),
      to: addMonthsIso(period.to, -12),
    }
  } else {
    // prior_period: the equal-length window ending the day before this one.
    const priorTo = addDays(period.from, -1)
    const priorFrom = addDays(priorTo, -daysBetween(period.from, period.to))
    prior = { key: 'prior', label: 'Prior period', from: priorFrom, to: priorTo }
  }
  return { cols: [{ ...base, label: 'Current' }, prior], truncated: false }
}

/** Roll each column vector up the account tree; sign-flip and prune like the
 *  legacy `treeify`, but over a value vector. */
function treeifyMatrix(
  rows: {
    id: string
    parent_id: string | null
    number: string | null
    name: string
    type: string
    is_summary: boolean
    vals: number[]
  }[],
  types: string[],
  colCount: number,
  showZero: boolean,
): MatrixRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const rolled = new Map<string, number[]>(rows.map((r) => [r.id, [...r.vals]]))
  for (const r of rows) {
    let p = r.parent_id
    while (p) {
      const acc = rolled.get(p)
      if (acc) for (let i = 0; i < colCount; i++) acc[i]! += r.vals[i]!
      p = byId.get(p)?.parent_id ?? null
    }
  }
  const children = new Map<string | null, typeof rows>()
  for (const r of rows) {
    if (!children.has(r.parent_id)) children.set(r.parent_id, [])
    children.get(r.parent_id)!.push(r)
  }
  const out: MatrixRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      if (!types.includes(r.type)) continue
      const raw = rolled.get(r.id) ?? []
      const flip = CREDIT_NORMAL.has(r.type)
      const values = raw.map((v) => (flip ? -v : v))
      const nonZero = values.some((v) => Math.abs(v) >= 0.005)
      if (nonZero || r.is_summary || showZero) {
        out.push({
          id: r.id,
          number: r.number,
          name: r.name,
          type: r.type,
          depth,
          isSummary: r.is_summary,
          values,
        })
      }
      walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  // Prune empty summary rows with no visible descendants (unless showing zeros).
  if (showZero) return out
  return out.filter((r, i) => {
    if (!r.isSummary || r.values.some((v) => Math.abs(v) >= 0.005)) return true
    const next = out[i + 1]
    return next !== undefined && next.depth > r.depth
  })
}

/**
 * Core engine: returns a signed value matrix over the accounts of `types`.
 * Appends variance columns when `compare` yields a current+prior pair.
 */
export async function statementMatrix(opts: {
  types: string[]
  mode: StatementMode
  period: { from: string; to: string }
  periodLabel: string
  breakout?: StatementBreakout
  compare?: StatementCompare
  basis?: StatementBasis
  dims?: StatementDimFilter
  showZero?: boolean
  /** Emit variance columns for a compare pair (default true when comparing). */
  variance?: boolean
}): Promise<StatementMatrix> {
  const breakout = opts.breakout ?? 'none'
  const compare = opts.compare ?? 'none'
  const basis = opts.basis ?? 'accrual'
  const showZero = opts.showZero ?? false

  const { cols, truncated } = await buildAmountColumns({
    mode: opts.mode,
    period: opts.period,
    breakout,
    compare,
    dims: opts.dims,
    periodLabel: opts.periodLabel,
  })

  // Overall window spanning every column, used to bound the base join.
  const froms = cols.map((c) => c.from).filter((x): x is string => !!x)
  const overallFrom = froms.length ? froms.reduce((a, b) => (a < b ? a : b)) : opts.period.from
  const overallTo = cols.map((c) => c.to).reduce((a, b) => (a > b ? a : b))
  const baseDate =
    opts.mode === 'balance'
      ? sql`e.posting_date <= ${overallTo}`
      : sql`e.posting_date >= ${overallFrom} and e.posting_date <= ${overallTo}`
  const cashFilter =
    basis === 'cash'
      ? sql` and e.id in (
          select l2.entry_id from journal_lines l2
            join accounts a2 on a2.id = l2.account_id
           where a2.type = 'asset_bank')`
      : sql``

  const filterCols = sql.join(
    cols.map(
      (c, i) => sql`coalesce(sum(l.amount) filter (where ${columnPredicate(c, opts.mode)}), 0) as ${sql.raw(`c${i}`)}`,
    ),
    sql`, `,
  )

  const res = (await db.execute(sql`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary, ${filterCols}
      from accounts a
      left join (journal_lines l join journal_entries e on e.id = l.entry_id)
        on l.account_id = a.id and ${baseDate} and ${dimFilterSql(opts.dims)}${cashFilter}
     group by a.id
     order by a.number nulls last, a.name
  `)) as unknown as {
    rows: Record<string, unknown>[]
  }

  const parsed = res.rows.map((r) => ({
    id: r.id as string,
    parent_id: (r.parent_id as string | null) ?? null,
    number: (r.number as string | null) ?? null,
    name: r.name as string,
    type: r.type as string,
    is_summary: r.is_summary as boolean,
    vals: cols.map((_, i) => Number(r[`c${i}`] ?? 0)),
  }))

  const rows = treeifyMatrix(parsed, opts.types, cols.length, showZero)

  // Assemble display columns; append variance for a compare pair.
  const columns: StatementColumn[] = cols.map((c) => ({
    key: c.key,
    label: c.label,
    kind: 'amount',
    from: c.from,
    to: c.to,
  }))
  const wantVariance = (opts.variance ?? true) && compare !== 'none' && cols.length === 2
  if (wantVariance) {
    columns.push({ key: 'var_abs', label: 'Variance', kind: 'variance_abs' })
    columns.push({ key: 'var_pct', label: 'Variance %', kind: 'variance_pct' })
    for (const row of rows) {
      const [cur, prior] = [row.values[0]!, row.values[1]!]
      const abs = cur - prior
      const pct = prior !== 0 ? (abs / Math.abs(prior)) * 100 : NaN
      row.values.push(abs, pct)
    }
  }

  return { columns, rows, truncated }
}

/** Recompute the variance columns of a values vector from its first two amount
 *  columns. Percentages are non-linear, so any derived/combined total must run
 *  through this rather than summing the variance cells directly. */
export function recomputeVariance(matrix: StatementMatrix, values: number[]): number[] {
  const amountIdx = matrix.columns.map((c, i) => (c.kind === 'amount' ? i : -1)).filter((i) => i >= 0)
  const varAbs = matrix.columns.findIndex((c) => c.kind === 'variance_abs')
  const varPct = matrix.columns.findIndex((c) => c.kind === 'variance_pct')
  if (varAbs < 0 || amountIdx.length < 2) return values
  const cur = values[amountIdx[0]!]!
  const prior = values[amountIdx[1]!]!
  values[varAbs] = cur - prior
  if (varPct >= 0) values[varPct] = prior !== 0 ? ((cur - prior) / Math.abs(prior)) * 100 : NaN
  return values
}

/** Per-column totals over the depth-0 rows of the given types (section total). */
export function sumSection(matrix: StatementMatrix, types: string[]): number[] {
  const totals = matrix.columns.map(() => 0)
  for (const row of matrix.rows) {
    if (row.depth !== 0 || !types.includes(row.type)) continue
    for (let i = 0; i < totals.length; i++) totals[i]! += row.values[i]!
  }
  return recomputeVariance(matrix, totals)
}

/** Element-wise signed combine of total vectors (e.g. revenue − cogs −
 *  expenses), then re-derive variance columns from the combined amounts. */
export function combineTotals(matrix: StatementMatrix, vectors: number[][], signs: number[]): number[] {
  const width = matrix.columns.length
  const out = new Array(width).fill(0)
  vectors.forEach((v, k) => {
    for (let i = 0; i < width; i++) out[i] += (signs[k] ?? 1) * (v[i] ?? 0)
  })
  return recomputeVariance(matrix, out)
}

// ---------------------------------------------------------------------------
// Statement view models — one render-ready shape for the page table AND the PDF
// ---------------------------------------------------------------------------

export const PNL_TYPES = ['income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred']
export const ASSET_TYPES = ['asset_bank', 'asset_receivable', 'asset_current_other', 'asset_fixed', 'asset_other']
export const LIABILITY_TYPES = [
  'liability_payable',
  'liability_card',
  'liability_current_other',
  'liability_long_term',
]
export const EQUITY_TYPES = ['equity']

export type StatementViewLine = {
  kind: 'section' | 'account' | 'subtotal' | 'total'
  label: string
  number?: string | null
  accountId?: string
  depth: number
  /** Bold grand-total emphasis (net income, total assets, …). */
  emphasis?: boolean
  /** Absent on section headers; reader-signed and column-aligned otherwise. */
  values?: number[]
}

export type StatementView = {
  columns: StatementColumn[]
  lines: StatementViewLine[]
  truncated: boolean
  /** Whether any comparison/variance columns are present. */
  hasVariance: boolean
}

type MatrixOpts = {
  breakout?: StatementBreakout
  compare?: StatementCompare
  basis?: StatementBasis
  dims?: StatementDimFilter
  showZero?: boolean
}

function accountLines(matrix: StatementMatrix, types: string[]): StatementViewLine[] {
  return matrix.rows
    .filter((r) => types.includes(r.type))
    .map((r) => ({
      kind: 'account' as const,
      label: r.name,
      number: r.number,
      accountId: r.id,
      depth: r.depth,
      emphasis: r.isSummary,
      values: r.values,
    }))
}

export type PnlLabels = {
  revenue: string
  costOfGoodsSold: string
  grossProfit: string
  expenses: string
  netIncome: string
  totalOf: (section: string) => string
}

/** Profit & Loss as a multi-column statement view. */
export async function profitAndLossView(
  period: { from: string; to: string },
  periodLabel: string,
  labels: PnlLabels,
  opts: MatrixOpts = {},
): Promise<StatementView> {
  const matrix = await statementMatrix({ types: PNL_TYPES, mode: 'flow', period, periodLabel, ...opts })
  const revenueTypes = ['income', 'income_other']
  const cogsTypes = ['cogs']
  const expenseTypes = ['expense', 'expense_other', 'expense_deferred']
  const revenue = sumSection(matrix, revenueTypes)
  const cogs = sumSection(matrix, cogsTypes)
  const expenses = sumSection(matrix, expenseTypes)
  const grossProfit = combineTotals(matrix, [revenue, cogs], [1, -1])
  const netIncome = combineTotals(matrix, [revenue, cogs, expenses], [1, -1, -1])

  const lines: StatementViewLine[] = []
  const section = (title: string, types: string[], total: number[]) => {
    lines.push({ kind: 'section', label: title, depth: 0 })
    lines.push(...accountLines(matrix, types))
    lines.push({ kind: 'subtotal', label: labels.totalOf(title), depth: 0, values: total })
  }
  section(labels.revenue, revenueTypes, revenue)
  section(labels.costOfGoodsSold, cogsTypes, cogs)
  lines.push({ kind: 'subtotal', label: labels.grossProfit, depth: 0, emphasis: true, values: grossProfit })
  section(labels.expenses, expenseTypes, expenses)
  lines.push({ kind: 'total', label: labels.netIncome, depth: 0, emphasis: true, values: netIncome })

  return { columns: matrix.columns, lines, truncated: matrix.truncated, hasVariance: matrix.columns.some((c) => c.kind !== 'amount') }
}

export type BalanceSheetLabels = {
  assets: string
  liabilities: string
  equity: string
  totalAssets: string
  totalLiabilities: string
  totalEquity: string
  accumulatedEarnings: string
  liabilitiesAndEquity: string
  totalOf: (section: string) => string
}

/** Balance Sheet as a multi-column statement view. Accumulated earnings are the
 *  lifetime P&L (no closing entries exist), computed per column from a
 *  cumulative P&L matrix so it composes with breakout/compare. */
export async function balanceSheetView(
  period: { from: string; to: string },
  periodLabel: string,
  labels: BalanceSheetLabels,
  opts: MatrixOpts = {},
): Promise<StatementView> {
  const matrix = await statementMatrix({
    types: [...ASSET_TYPES, ...LIABILITY_TYPES, ...EQUITY_TYPES],
    mode: 'balance',
    period,
    periodLabel,
    ...opts,
  })
  // Cumulative P&L → retained/accumulated earnings, same columns. Net income is
  // revenue − cogs − expenses, so it must be combined with signs — summing all
  // P&L types would (wrongly) add expenses as positive.
  const pnl = await statementMatrix({ types: PNL_TYPES, mode: 'balance', period, periodLabel, ...opts })
  const accumulated = combineTotals(
    pnl,
    [
      sumSection(pnl, ['income', 'income_other']),
      sumSection(pnl, ['cogs']),
      sumSection(pnl, ['expense', 'expense_other', 'expense_deferred']),
    ],
    [1, -1, -1],
  )

  const assets = sumSection(matrix, ASSET_TYPES)
  const liabilities = sumSection(matrix, LIABILITY_TYPES)
  const equityPosted = sumSection(matrix, EQUITY_TYPES)
  const equityTotal = combineTotals(matrix, [equityPosted, accumulated], [1, 1])
  const liabAndEquity = combineTotals(matrix, [liabilities, equityPosted, accumulated], [1, 1, 1])

  const lines: StatementViewLine[] = []
  lines.push({ kind: 'section', label: labels.assets, depth: 0 })
  lines.push(...accountLines(matrix, ASSET_TYPES))
  lines.push({ kind: 'subtotal', label: labels.totalAssets, depth: 0, emphasis: true, values: assets })

  lines.push({ kind: 'section', label: labels.liabilities, depth: 0 })
  lines.push(...accountLines(matrix, LIABILITY_TYPES))
  lines.push({ kind: 'subtotal', label: labels.totalLiabilities, depth: 0, values: liabilities })

  lines.push({ kind: 'section', label: labels.equity, depth: 0 })
  lines.push(...accountLines(matrix, EQUITY_TYPES))
  lines.push({ kind: 'account', label: labels.accumulatedEarnings, depth: 1, values: accumulated })
  lines.push({ kind: 'subtotal', label: labels.totalEquity, depth: 0, values: equityTotal })

  lines.push({ kind: 'total', label: labels.liabilitiesAndEquity, depth: 0, emphasis: true, values: liabAndEquity })

  return { columns: matrix.columns, lines, truncated: matrix.truncated, hasVariance: matrix.columns.some((c) => c.kind !== 'amount') }
}
