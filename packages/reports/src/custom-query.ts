// Compiler for user-built custom reports (ported from beaconhs
// packages/reports/src/custom-query.ts). SQL-injection-safe: every identifier
// comes from the entity catalog (compile-time constants) and all values bind
// as numbered parameters.
//
// Two modes:
//   rows      — detail rows (optionally bucketed into sections by groupBy).
//   summarize — GROUP BY breakouts + aggregate measures (count/sum/avg/…), with
//               optional temporal bucketing on a date/timestamp breakout.
//
// This module only COMPILES (query plan → { text, values }); execution and
// result shaping live in run.ts so the compiler stays pure and testable.

import { columnRef, entityColumn, type ReportEntity, type ReportEntityColumn } from './entities'
import { compileCustomFilters, compileRuleGroup, SqlParams } from './filters'
import {
  REPORT_AGG_FNS,
  REPORT_TEMPORAL_BINS,
  formatLabel,
  type ReportAggFn,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportMeasure,
} from './types'

export const DEFAULT_REPORT_LIMIT = 1000
export const MAX_REPORT_ROWS = 10_000

export type CompiledReportQuery = {
  text: string
  values: unknown[]
  mode: 'rows' | 'summarize'
  /** Rows mode: the validated output column keys, in order. */
  columns: string[]
  /** Summarize mode: validated breakouts/measures, in select order. */
  breakouts: ReportBreakout[]
  measures: ReportMeasure[]
  /** Rows mode: validated section-grouping column, if any. */
  groupBy: string | null
  limit: number
}

export type CompileCustomQueryOpts = {
  /** Extra clamp under MAX_REPORT_ROWS (e.g. 50 for studio previews). */
  maxRows?: number
  /** Org fiscal-year start month (1–12) for the `fiscal_*` temporal bins. The
   *  engine stays DB-free — the caller supplies it. Defaults to 1 (calendar). */
  fiscalStartMonth?: number
}

/**
 * Compile a ReportCustomQuery into parameterized SQL scoped to one org.
 * `orgId` is bound as the FIRST parameter and ANDed into every WHERE — no
 * plan can read outside the caller's org.
 */
export function compileCustomQuery(
  entity: ReportEntity,
  customQuery: unknown,
  orgId: string,
  opts: CompileCustomQueryOpts = {},
): CompiledReportQuery {
  const q = (customQuery ?? null) as ReportCustomQuery | null
  if (!q || q.entity !== entity.key) {
    throw new Error('Custom query missing or has unknown entity')
  }
  return q.mode === 'summarize'
    ? compileSummarize(entity, q, orgId, opts)
    : compileRows(entity, q, orgId, opts)
}

/** The entity's implicit predicates: org scope + optional baseFilter. */
function implicitWhere(entity: ReportEntity, orgId: string, params: SqlParams): string[] {
  const parts = [`${entity.orgColumn} = ${params.add(orgId)}`]
  if (entity.baseFilter) {
    const base = compileRuleGroup(entity, entity.baseFilter, params)
    if (base) parts.push(base)
  }
  return parts
}

// --- rows mode ---------------------------------------------------------------

function compileRows(
  entity: ReportEntity,
  q: ReportCustomQuery,
  orgId: string,
  opts: CompileCustomQueryOpts,
): CompiledReportQuery {
  const requestedColumns = (q.columns ?? []).filter((c) => columnRef(entity, c))
  if (requestedColumns.length === 0) {
    throw new Error('Custom query requires at least one valid column')
  }

  const params = new SqlParams()
  const whereParts = implicitWhere(entity, orgId, params)
  const filters = compileCustomFilters(entity, q, params)
  if (filters) whereParts.push(`(${filters})`)

  // The section-grouping column must be selected so run.ts can bucket rows.
  const groupBy = q.groupBy && columnRef(entity, q.groupBy) ? q.groupBy : null
  const selectKeys = [...requestedColumns]
  if (groupBy && !selectKeys.includes(groupBy)) selectKeys.push(groupBy)

  const selectList = selectKeys.map((c) => `${columnRef(entity, c)} AS "${c}"`).join(', ')
  // Every sort column resolves through the catalog; unknowns are dropped.
  const sortSpecs = (q.sorts ?? [])
    .map((s) => {
      const ref = s.column ? columnRef(entity, s.column) : null
      return ref ? `${ref} ${s.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : null
    })
    .filter((s): s is string => s !== null)
    .slice(0, 3)
  const limit = resolveLimit(q.limit, opts.maxRows)

  const text = [
    `SELECT ${selectList}`,
    `FROM ${entity.from}`,
    `WHERE ${whereParts.join(' AND ')}`,
    sortSpecs.length ? `ORDER BY ${sortSpecs.join(', ')}` : '',
    `LIMIT ${limit}`,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    text,
    values: params.values,
    mode: 'rows',
    columns: requestedColumns,
    breakouts: [],
    measures: [],
    groupBy,
    limit,
  }
}

// --- summarize mode ----------------------------------------------------------

function compileSummarize(
  entity: ReportEntity,
  q: ReportCustomQuery,
  orgId: string,
  opts: CompileCustomQueryOpts,
): CompiledReportQuery {
  // Resolve breakouts (group-by dimensions) and measures from the catalog.
  const breakouts = (q.breakouts ?? []).filter((b) => columnRef(entity, b.column))
  let measures = (q.measures ?? []).filter(
    (m) => m.fn === 'count' || (m.column && columnRef(entity, m.column)),
  )
  measures = measures.filter((m) => REPORT_AGG_FNS.includes(m.fn))
  if (measures.length === 0) measures = [{ fn: 'count' }]

  const startMonth = opts.fiscalStartMonth && opts.fiscalStartMonth >= 1 && opts.fiscalStartMonth <= 12 ? opts.fiscalStartMonth : 1
  const dimSelect = breakouts.map((b, i) => `${dimExpr(entity, b, startMonth)} AS "d${i}"`)
  const measSelect = measures.map((m, i) => `${measureExpr(entity, m)} AS "m${i}"`)

  const params = new SqlParams()
  const whereParts = implicitWhere(entity, orgId, params)
  const filters = compileCustomFilters(entity, q, params)
  if (filters) whereParts.push(`(${filters})`)

  // Order: a temporal trend reads best chronologically; otherwise rank by the
  // first measure (top-N). The first measure's ordinal is dims + 1.
  const firstMeasureOrdinal = breakouts.length + 1
  const orderSql =
    breakouts.length === 0
      ? ''
      : breakouts[0]?.bin
        ? 'ORDER BY 1 ASC'
        : `ORDER BY ${firstMeasureOrdinal} DESC NULLS LAST`

  const limit = resolveLimit(q.limit, opts.maxRows)

  const text = [
    `SELECT ${[...dimSelect, ...measSelect].join(', ')}`,
    `FROM ${entity.from}`,
    `WHERE ${whereParts.join(' AND ')}`,
    breakouts.length > 0 ? `GROUP BY ${breakouts.map((_, i) => i + 1).join(', ')}` : '',
    orderSql,
    `LIMIT ${limit}`,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    text,
    values: params.values,
    mode: 'summarize',
    columns: [],
    breakouts,
    measures,
    groupBy: null,
    limit,
  }
}

/** SQL for a group-by dimension, with optional temporal bucketing. The bin is
 *  re-validated against the whitelist before interpolation (defence in depth).
 *  `fiscal_*` bins bucket to the fiscal calendar: shift the date back by
 *  (startMonth − 1) months so fiscal boundaries align to calendar ones, truncate,
 *  then shift forward. `startMonth` is a clamped integer, never user input. */
function dimExpr(entity: ReportEntity, b: ReportBreakout, startMonth = 1): string {
  const ref = columnRef(entity, b.column)!
  const bin = b.bin && REPORT_TEMPORAL_BINS.includes(b.bin) ? b.bin : null
  if (!bin) return ref
  if (bin === 'fiscal_period') return `date_trunc('month', ${ref})`
  if (bin === 'fiscal_quarter' || bin === 'fiscal_year') {
    const unit = bin === 'fiscal_year' ? 'year' : 'quarter'
    const shift = startMonth - 1
    if (shift === 0) return `date_trunc('${unit}', ${ref})`
    return `(date_trunc('${unit}', (${ref})::timestamp - interval '${shift} months') + interval '${shift} months')`
  }
  return `date_trunc('${bin}', ${ref})`
}

/** SQL for an aggregate measure. Identifiers come from the catalog only. */
function measureExpr(entity: ReportEntity, m: ReportMeasure): string {
  if (m.fn === 'count') return 'COUNT(*)::int'
  const ref = columnRef(entity, m.column ?? '')!
  switch (m.fn) {
    case 'count_distinct':
      return `COUNT(DISTINCT ${ref})::int`
    case 'sum':
      return `SUM(${ref})`
    case 'avg':
      return `ROUND(AVG(${ref})::numeric, 2)`
    case 'min':
      return `MIN(${ref})`
    case 'max':
      return `MAX(${ref})`
    default:
      return 'COUNT(*)::int'
  }
}

// --- labels & defaults (shared by run.ts and the studio) ----------------------

const AGG_FN_LABEL: Record<ReportAggFn, string> = {
  count: 'Count',
  count_distinct: 'Distinct count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
}

export function labelFor(entity: ReportEntity, key: string): string {
  return entityColumn(entity, key)?.label ?? formatLabel(key)
}

export function breakoutLabel(entity: ReportEntity, b: ReportBreakout): string {
  const base = labelFor(entity, b.column)
  return b.bin ? `${base} (by ${b.bin})` : base
}

export function measureLabel(entity: ReportEntity, m: ReportMeasure): string {
  if (m.label) return m.label
  if (m.fn === 'count') return 'Count'
  return `${AGG_FN_LABEL[m.fn]} of ${labelFor(entity, m.column ?? '')}`
}

export function resolveLimit(requested: number | null | undefined, maxRows?: number): number {
  const n = Number(requested ?? DEFAULT_REPORT_LIMIT)
  let limit = Math.min(Math.max(Number.isFinite(n) ? n : DEFAULT_REPORT_LIMIT, 1), MAX_REPORT_ROWS)
  if (maxRows) limit = Math.min(limit, maxRows)
  return limit
}

const DEFAULT_COLUMN_COUNT = 7

export function isOperationalColumn(column: ReportEntityColumn): boolean {
  return column.kind !== 'uuid' && column.key !== 'id' && column.key !== 'org_id'
}

/** A practical default column set for a fresh report on this entity. */
export function defaultColumnsFor(entity: ReportEntity, limit = DEFAULT_COLUMN_COUNT): string[] {
  const preferred = entity.columns.filter(isOperationalColumn).slice(0, limit)
  return (preferred.length ? preferred : entity.columns.slice(0, limit)).map((c) => c.key)
}

/** A fresh rows-mode plan with sensible defaults. */
export function defaultRowsQuery(entity: ReportEntity): ReportCustomQuery {
  return {
    entity: entity.key,
    mode: 'rows',
    columns: defaultColumnsFor(entity),
    breakouts: [],
    measures: [],
    filters: null,
    groupBy: null,
    ...(entity.defaultSort ? { sorts: [entity.defaultSort] } : {}),
    limit: DEFAULT_REPORT_LIMIT,
  }
}
