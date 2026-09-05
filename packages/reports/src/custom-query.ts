// Compiler for user-built custom reports. SQL-injection-safe: every identifier
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

import { bindReportFromAsOf, columnRef, entityColumn, type ReportEntity, type ReportEntityColumn } from './entities'
import { compileCustomFilters, compileRuleGroup, SqlParams } from './filters'
import {
  REPORT_AGG_FNS,
  REPORT_TEMPORAL_BINS,
  formatLabel,
  type ReportAggFn,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportMeasure,
  type ReportPageRequest,
} from './types'

export const DEFAULT_REPORT_LIMIT = 1000
export const MAX_REPORT_ROWS = 10_000
/** Reserved raw-row key carrying COUNT(*) OVER() for a paged result. */
export const REPORT_TOTAL_ROWS_COLUMN = '__report_total_rows'

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
  /** Sectioned summarize: totals flags echoed for the shaper. */
  totals?: ReportCustomQuery['totals']
  limit: number
  /** Normalized page request. Present only for a rows-mode paged execution. */
  page?: ReportPageRequest
  /** Exact same FROM/WHERE as `text`, used only when a nonzero offset returns
   *  no rows and therefore COUNT(*) OVER() has no carrier row. */
  countText?: string
}

export type CompileCustomQueryOpts = {
  /** Server-owned allowlist; an empty array grants no entity rows. */
  allowedSubsidiaryIds?: readonly string[] | null;
  /** Extra clamp under MAX_REPORT_ROWS (e.g. 50 for studio previews). */
  maxRows?: number
  /** Org fiscal-year start month (1–12) for the `fiscal_*` temporal bins. The
   *  engine stays DB-free — the caller supplies it. Defaults to 1 (calendar). */
  fiscalStartMonth?: number
  /** Org business day (YYYY-MM-DD). Required when the entity FROM uses the
   *  as-of sentinel — bound as a parameter, never CURRENT_DATE. */
  asOf?: string
  /** Request one page from an entity whose catalog declares `pagination`.
   *  This deliberately overrides the saved query's legacy materialization
   *  limit, allowing complete history to be retrieved page by page. */
  page?: ReportPageRequest
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
  if (opts.page && q.mode === 'summarize') {
    throw new Error('Paged report execution supports rows mode only')
  }
  return q.mode === 'summarize'
    ? compileSummarize(entity, q, orgId, opts)
    : compileRows(entity, q, orgId, opts)
}

/** Shared server-owned legal-entity policy for reports and Insights. */
export function compileSubsidiaryScope(
  entity: ReportEntity,
  allowedSubsidiaryIds: readonly string[] | null | undefined,
  bind: (value: unknown) => string,
): string | null {
  if (allowedSubsidiaryIds == null) return null
  const scope = entity.subsidiaryScope
  if (scope === undefined) throw new Error(`Report entity ${entity.key} has no subsidiary policy`)
  if (allowedSubsidiaryIds.length === 0) return 'FALSE'
  if (!scope) return null
  const predicate = `${scope.column} = ANY(${bind([...allowedSubsidiaryIds])}::uuid[])`
  return scope.sharedNull ? `(${scope.column} IS NULL OR ${predicate})` : predicate
}

/** The entity's implicit predicates: org scope + optional baseFilter. */
function implicitWhere(entity: ReportEntity, orgId: string, params: SqlParams, opts: CompileCustomQueryOpts): string[] {
  const parts = [`${entity.orgColumn} = ${params.add(orgId)}`]
  const subsidiary = compileSubsidiaryScope(entity, opts.allowedSubsidiaryIds, (value) => params.add(value))
  if (subsidiary) parts.push(subsidiary)
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
  const whereParts = implicitWhere(entity, orgId, params, opts)
  const from = bindReportFromAsOf(entity.from, opts.asOf, (value) => params.add(value))
  const countFrom = from.replace(/\r?\n/g, ' ')
  const filters = compileCustomFilters(entity, q, params)
  if (filters) whereParts.push(`(${filters})`)

  // The section-grouping column must be selected so run.ts can bucket rows.
  const groupBy = q.groupBy && columnRef(entity, q.groupBy) ? q.groupBy : null
  const selectKeys = [...requestedColumns]
  if (groupBy && !selectKeys.includes(groupBy)) selectKeys.push(groupBy)

  // Native cell-link metadata travels in hidden selected columns. Catalog
  // mistakes fail loudly instead of producing a display value that opens the
  // wrong record.
  const activeCellLinks = (entity.cellLinks ?? []).filter((link) => requestedColumns.includes(link.column))
  for (const link of activeCellLinks) {
    for (const key of [link.entryIdColumn, link.docIdColumn, link.docKindColumn]) {
      if (!key) continue
      if (!columnRef(entity, key)) {
        throw new Error(`entity ${entity.key} cell link references unknown column ${key}`)
      }
      if (!selectKeys.includes(key)) selectKeys.push(key)
    }
  }

  const page = opts.page ? resolveReportPage(entity, opts.page, opts.maxRows) : null

  const selectList = [
    ...selectKeys.map((c) => `${columnRef(entity, c)} AS "${c}"`),
    ...(page ? [`COUNT(*) OVER() AS "${REPORT_TOTAL_ROWS_COLUMN}"`] : []),
  ].join(', ')
  // Every sort column resolves through the catalog; unknowns are dropped.
  const sortSpecs = (q.sorts ?? [])
    .map((s) => {
      const ref = s.column ? columnRef(entity, s.column) : null
      return ref ? `${ref} ${s.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : null
    })
    .filter((s): s is string => s !== null)
    .slice(0, 3)
  const limit = page?.limit ?? resolveLimit(q.limit, opts.maxRows)

  const text = [
    `SELECT ${selectList}`,
    `FROM ${from}`,
    `WHERE ${whereParts.join(' AND ')}`,
    sortSpecs.length ? `ORDER BY ${sortSpecs.join(', ')}` : '',
    `LIMIT ${limit}`,
    page ? `OFFSET ${page.offset}` : '',
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
    ...(page ? {
      page,
      countText: `SELECT COUNT(*) AS "${REPORT_TOTAL_ROWS_COLUMN}" FROM ${countFrom} WHERE ${whereParts.join(' AND ')}`,
    } : {}),
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
  const whereParts = implicitWhere(entity, orgId, params, opts)
  const from = bindReportFromAsOf(entity.from, opts.asOf, (value) => params.add(value))
  const filters = compileCustomFilters(entity, q, params)
  if (filters) whereParts.push(`(${filters})`)

  // Order: sectioned summaries read as a ledger — enum dims follow their
  // CATALOG option order (a payroll journal lists earnings before deductions
  // before employer contributions), other dims alphabetically; a temporal
  // trend reads chronologically; otherwise rank by the first measure (top-N).
  const firstMeasureOrdinal = breakouts.length + 1
  const sectioned = !!q.groupBy && breakouts.some((b) => b.column === q.groupBy && !b.bin)
  const sectionedDimOrder = (b: ReportBreakout, i: number): string => {
    const column = entityColumn(entity, b.column)
    if (!b.bin && (column?.kind === 'enum' || column?.kind === 'boolean') && column.options?.length) {
      // Options are server-authored catalog constants, single-quoted safely.
      const list = column.options.map((option) => `'${option.replace(/'/g, "''")}'`).join(', ')
      return `array_position(ARRAY[${list}]::text[], ${columnRef(entity, b.column)}) ASC NULLS LAST`
    }
    return `${i + 1} ASC`
  }
  const orderSql =
    breakouts.length === 0
      ? ''
      : sectioned
        ? `ORDER BY ${breakouts.map((b, i) => sectionedDimOrder(b, i)).join(', ')}`
        : breakouts[0]?.bin
          ? 'ORDER BY 1 ASC'
          : `ORDER BY ${firstMeasureOrdinal} DESC NULLS LAST`

  const limit = resolveLimit(q.limit, opts.maxRows)

  const text = [
    `SELECT ${[...dimSelect, ...measSelect].join(', ')}`,
    `FROM ${from}`,
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
    // Display-level sectioning by one (un-binned) breakout; the shaper splits.
    groupBy: sectioned ? q.groupBy ?? null : null,
    totals: sectioned ? q.totals ?? null : null,
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
    case 'latest': {
      // Exact end-of-window value of a running figure: the value carried by
      // the chronologically last row in the group.
      if (!entity.latestOrderExpr) {
        throw new Error(`entity ${entity.key} does not support the 'latest' aggregate`)
      }
      return `(ARRAY_AGG(${ref} ORDER BY ${entity.latestOrderExpr}))[1]`
    }
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
  latest: 'Latest',
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

/** Normalize untrusted page numbers against the entity-authored policy. */
export function resolveReportPage(
  entity: ReportEntity,
  requested: ReportPageRequest,
  maxRows?: number,
): ReportPageRequest {
  if (!entity.pagination) {
    throw new Error(`entity ${entity.key} does not support paged execution`)
  }
  const configuredMax = Math.min(
    Math.max(Math.trunc(entity.pagination.maxPageSize) || 1, 1),
    MAX_REPORT_ROWS,
  )
  const effectiveMax = Number.isFinite(maxRows) && Number(maxRows) > 0
    ? Math.min(configuredMax, Math.max(1, Math.trunc(Number(maxRows))))
    : configuredMax
  const configuredDefault = Math.min(
    Math.max(Math.trunc(entity.pagination.defaultPageSize) || 1, 1),
    effectiveMax,
  )
  const rawLimit = Number(requested.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), effectiveMax)
    : configuredDefault
  const rawOffset = Number(requested.offset)
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0
  return { offset, limit }
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
