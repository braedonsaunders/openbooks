// The Insights SQL compiler: InsightQuery → parameterized Postgres.
//
// Security model (mirrors engine/src/sqlapi.ts): every physical identifier comes
// from the authored catalog whitelist (source `from`, `orgColumn`, field `expr`)
// — NEVER from caller input. Callers only name catalog KEYS; the compiler looks
// each key up and fails closed on anything unknown. Every VALUE binds as a
// numbered ($1…) parameter. The org id is always ANDed into the WHERE as $1, so
// no query can escape its org. Output is a single SELECT ready for the read-only
// executor.

import { REPORT_ENTITY_MAP, SqlParams, compileRuleGroup } from '@openbooks/reports'
import { getSource } from './catalog'
import { fieldRef, sourceField, type AnalyticsField, type AnalyticsSource } from './semantic'
import type {
  AggFn,
  CompiledQuery,
  DateBin,
  FilterOp,
  InsightQuery,
  QueryDimension,
  QueryFilter,
  QueryMeasure,
  ResultColumn,
  SemanticType,
} from './types'

/** Machine codes for every compile failure — the API layer translates these
 *  for the studio; `message` stays the English fallback. */
export type InsightCompileErrorCode =
  | 'unknown_source'
  | 'unknown_field'
  | 'unknown_aggregation'
  | 'aggregation_needs_field'
  | 'not_a_dimension'
  | 'not_a_measure'
  | 'unknown_operator'
  | 'unknown_bin'
  | 'contains_needs_text'
  | 'last_n_days_needs_number'
  | 'no_columns'

export class InsightCompileError extends Error {
  readonly name = 'InsightCompileError'
  readonly code: InsightCompileErrorCode
  /** The offending key/operator/etc., for interpolation into a translated message. */
  readonly subject?: string

  constructor(code: InsightCompileErrorCode, message: string, subject?: string) {
    super(message)
    this.code = code
    this.subject = subject
  }
}

/**
 * Locale hooks for the display labels the compiler bakes into ResultColumns.
 * Injected by the caller (the web API layer builds one from the request
 * locale); every hook is optional and defaults to the authored English.
 * Keeping this a plain callback bag keeps the package free of any i18n
 * runtime.
 */
export type InsightLabelResolver = {
  /** Display label for a catalog field. */
  field?: (sourceKey: string, field: AnalyticsField) => string
  /** Column label for the COUNT(*) measure. */
  count?: () => string
  /** Column label for an aggregated measure over `fieldLabel`. */
  measure?: (agg: Exclude<AggFn, 'count'>, fieldLabel: string) => string
  /** Column label for a date-binned dimension. */
  binnedDimension?: (fieldLabel: string, bin: DateBin) => string
}

const MAX_ROWS = 10_000
const AGG_FNS: AggFn[] = ['sum', 'count', 'avg', 'min', 'max']
const DATE_BINS: DateBin[] = ['day', 'week', 'month', 'quarter', 'year']

/** Whitelist-safe output alias: caller-provided aliases are re-slugged, never
 *  interpolated raw. Bounded so a stored plan can't emit a pathological ident. */
function safeAlias(raw: string | undefined, fallback: string): string {
  const base = (raw ?? fallback).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
  const slug = base.length ? base : fallback
  return slug.slice(0, 60)
}

/** Aggregation SQL for a measure over an already-resolved field expression. */
function aggSql(agg: AggFn, expr: string | null): string {
  if (agg === 'count') return 'count(*)'
  if (!expr)
    throw new InsightCompileError('aggregation_needs_field', `aggregation "${agg}" requires a field`, agg)
  switch (agg) {
    case 'sum':
      return `sum(${expr})`
    case 'avg':
      return `avg(${expr})`
    case 'min':
      return `min(${expr})`
    case 'max':
      return `max(${expr})`
    default:
      throw new InsightCompileError('unknown_aggregation', `unknown aggregation "${agg}"`, agg)
  }
}

/** date_trunc wrapper for a temporal dimension bin. */
function binSql(expr: string, bin: DateBin): string {
  if (!DATE_BINS.includes(bin))
    throw new InsightCompileError('unknown_bin', `unknown date bin "${bin}"`, bin)
  return `date_trunc('${bin}', ${expr})::date`
}

/** The semantic type an aggregated measure produces. count → number; otherwise
 *  it inherits the field's type (sum/avg of currency is currency). */
function measureType(agg: AggFn, field: AnalyticsField | null): SemanticType {
  if (agg === 'count') return 'number'
  return field?.semanticType === 'currency' ? 'currency' : 'number'
}

type Ctx = {
  source: AnalyticsSource
  params: unknown[]
  /** Org business day (YYYY-MM-DD). Relative date filters bind this, never current_date. */
  asOf: string
}

/** Push a bound value and return its `$n` placeholder. */
function bind(ctx: Ctx, value: unknown): string {
  ctx.params.push(value)
  return `$${ctx.params.length}`
}

function compileFilter(ctx: Ctx, filter: QueryFilter): string {
  const field = sourceField(ctx.source, filter.field)
  if (!field)
    throw new InsightCompileError('unknown_field', `unknown filter field "${filter.field}"`, filter.field)
  const ref = field.expr
  const op: FilterOp = filter.op
  const v = filter.value

  switch (op) {
    case 'eq':
      return `${ref} = ${bind(ctx, v)}`
    case 'neq':
      return `${ref} <> ${bind(ctx, v)}`
    case 'gt':
      return `${ref} > ${bind(ctx, v)}`
    case 'gte':
      return `${ref} >= ${bind(ctx, v)}`
    case 'lt':
      return `${ref} < ${bind(ctx, v)}`
    case 'lte':
      return `${ref} <= ${bind(ctx, v)}`
    case 'contains': {
      if (typeof v !== 'string')
        throw new InsightCompileError('contains_needs_text', '"contains" needs a text value')
      return `${ref} ilike ${bind(ctx, `%${v}%`)}`
    }
    case 'in':
    case 'not_in': {
      const list = Array.isArray(v) ? v : v == null ? [] : [v]
      if (list.length === 0) return op === 'in' ? 'false' : 'true'
      return `${ref} ${op === 'in' ? '' : 'not '}= any(${bind(ctx, list)})`
    }
    case 'is_null':
      return `${ref} is null`
    case 'is_not_null':
      return `${ref} is not null`
    case 'last_n_days': {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0)
        throw new InsightCompileError('last_n_days_needs_number', '"within last N days" needs a number')
      return `${ref} >= (${bind(ctx, ctx.asOf)}::date - ${bind(ctx, Math.trunc(n))}::int)`
    }
    case 'this_month':
      return `${ref} >= date_trunc('month', ${bind(ctx, ctx.asOf)}::date)::date and ${ref} < (date_trunc('month', ${bind(ctx, ctx.asOf)}::date) + interval '1 month')::date`
    case 'this_quarter':
      return `${ref} >= date_trunc('quarter', ${bind(ctx, ctx.asOf)}::date)::date and ${ref} < (date_trunc('quarter', ${bind(ctx, ctx.asOf)}::date) + interval '3 months')::date`
    case 'this_year':
      return `${ref} >= date_trunc('year', ${bind(ctx, ctx.asOf)}::date)::date and ${ref} < (date_trunc('year', ${bind(ctx, ctx.asOf)}::date) + interval '1 year')::date`
    case 'ytd':
      return `${ref} >= date_trunc('year', ${bind(ctx, ctx.asOf)}::date)::date and ${ref} <= ${bind(ctx, ctx.asOf)}::date`
    default:
      throw new InsightCompileError('unknown_operator', `unknown filter operator "${op as string}"`, op as string)
  }
}

/** The source's authored implicit predicate (e.g. "only active tiers"), shared
 *  verbatim with the report executor: the same catalog `baseFilter` compiled by
 *  the same rule compiler, with its bind params numbered after the org id. */
function compileBaseFilter(ctx: Ctx): string | null {
  const baseFilter = ctx.source.baseFilter
  if (!baseFilter) return null
  const entity = REPORT_ENTITY_MAP[ctx.source.key]
  if (!entity) return null
  const params = new SqlParams(ctx.params.length)
  const clause = compileRuleGroup(entity, baseFilter, params)
  ctx.params.push(...params.values)
  return clause
}

function resolveDimension(source: AnalyticsSource, dim: QueryDimension): { expr: string; alias: string; field: AnalyticsField } {
  const field = sourceField(source, dim.field)
  if (!field) throw new InsightCompileError('unknown_field', `unknown dimension "${dim.field}"`, dim.field)
  if (!field.canDimension)
    throw new InsightCompileError('not_a_dimension', `"${dim.field}" cannot be a dimension`, dim.field)
  const binned = dim.bin && field.canBin
  const expr = binned ? binSql(field.expr, dim.bin!) : field.expr
  const alias = safeAlias(dim.alias, binned ? `${field.key}_${dim.bin}` : field.key)
  return { expr, alias, field }
}

function resolveMeasure(source: AnalyticsSource, m: QueryMeasure): { expr: string; alias: string; field: AnalyticsField | null } {
  if (!AGG_FNS.includes(m.agg))
    throw new InsightCompileError('unknown_aggregation', `unknown aggregation "${m.agg}"`, m.agg)
  if (m.agg === 'count') {
    return { expr: 'count(*)', alias: safeAlias(m.alias, 'count'), field: null }
  }
  const field = sourceField(source, m.field ?? '')
  if (!field)
    throw new InsightCompileError('unknown_field', `unknown measure field "${m.field}"`, m.field)
  if (!field.canMeasure)
    throw new InsightCompileError('not_a_measure', `"${m.field}" is not a numeric measure`, m.field)
  return {
    expr: aggSql(m.agg, field.expr),
    alias: safeAlias(m.alias, `${m.agg}_${field.key}`),
    field,
  }
}

/** Compile an InsightQuery into parameterized SQL + the output column plan.
 *  `labels` localizes the display labels baked into the column plan; omitted
 *  hooks fall back to the authored English. */
export function compileInsightQuery(
  query: InsightQuery,
  orgId: string,
  labels: InsightLabelResolver = {},
  asOf = '1970-01-01',
): CompiledQuery {
  const source = getSource(query.source)
  if (!source)
    throw new InsightCompileError('unknown_source', `unknown source "${query.source}"`, query.source)
  const fieldLabel = (f: AnalyticsField) => labels.field?.(source.key, f) ?? f.label

  const ctx: Ctx = { source, params: [orgId], asOf }
  const wheres: string[] = [`${source.orgColumn} = $1`]
  const base = compileBaseFilter(ctx)
  if (base) wheres.push(base)
  for (const f of query.filters ?? []) wheres.push(compileFilter(ctx, f))

  const limit = clampLimit(query.limit)

  const measures = query.measures ?? []
  const dimensions = query.dimensions ?? []
  const isAggregate = measures.length > 0 || dimensions.length > 0

  const selects: string[] = []
  const columns: ResultColumn[] = []
  const seenAlias = new Set<string>()
  const uniq = (a: string) => {
    let alias = a
    let n = 2
    while (seenAlias.has(alias)) alias = `${a}_${n++}`
    seenAlias.add(alias)
    return alias
  }

  if (!isAggregate) {
    // Raw detail query — the source's default columns.
    for (const key of source.detailColumns) {
      const field = sourceField(source, key)
      if (!field) continue
      const alias = uniq(field.key)
      selects.push(`${field.expr} as "${alias}"`)
      columns.push({
        key: alias,
        label: fieldLabel(field),
        type: field.semanticType,
        role: 'dimension',
        valueKind: field.valueKind,
      })
    }
  } else {
    for (const dim of dimensions) {
      const r = resolveDimension(source, dim)
      const alias = uniq(r.alias)
      selects.push(`${r.expr} as "${alias}"`)
      const base = fieldLabel(r.field)
      const label =
        dim.bin && r.field.canBin
          ? (labels.binnedDimension?.(base, dim.bin) ?? `${base} (${dim.bin})`)
          : base
      columns.push({
        key: alias,
        label,
        type: r.field.semanticType,
        role: 'dimension',
        valueKind: dim.bin && r.field.canBin ? undefined : r.field.valueKind,
      })
    }
    for (const m of measures) {
      const r = resolveMeasure(source, m)
      const alias = uniq(r.alias)
      selects.push(`${r.expr} as "${alias}"`)
      const label =
        m.agg === 'count'
          ? (labels.count?.() ?? 'Count')
          : (labels.measure?.(m.agg, r.field ? fieldLabel(r.field) : '') ??
            defaultMeasureLabel(m, r.field))
      columns.push({ key: alias, label, type: measureType(m.agg, r.field), role: 'measure' })
    }
  }

  if (selects.length === 0)
    throw new InsightCompileError('no_columns', 'query selects no columns')

  // GROUP BY every dimension by ordinal position (safe — no user identifiers).
  const groupBy =
    isAggregate && dimensions.length > 0
      ? ` group by ${dimensions.map((_, i) => i + 1).join(', ')}`
      : ''

  const orderBy = compileOrderBy(query, columns, source, isAggregate)

  const sql =
    `select ${selects.join(', ')}\n` +
    `from ${source.from}\n` +
    `where ${wheres.join(' and ')}` +
    groupBy +
    orderBy +
    `\nlimit ${limit}`

  return { sql, params: ctx.params, columns, limit }
}

function compileOrderBy(
  query: InsightQuery,
  columns: ResultColumn[],
  source: AnalyticsSource,
  isAggregate: boolean,
): string {
  const byKey = new Map(columns.map((c, i) => [c.key, i + 1]))
  const parts: string[] = []
  for (const s of query.sort ?? []) {
    const ord = byKey.get(s.ref)
    if (!ord) continue // ignore refs that aren't in the output
    parts.push(`${ord} ${s.dir === 'asc' ? 'asc' : 'desc'} nulls last`)
  }
  if (parts.length > 0) return `\norder by ${parts.join(', ')}`

  // Sensible defaults: measure queries sort by the first measure desc; detail
  // queries follow the source default sort when that column is present.
  if (isAggregate) {
    const firstMeasure = columns.find((c) => c.role === 'measure')
    if (firstMeasure) return `\norder by ${byKey.get(firstMeasure.key)} desc nulls last`
    const firstDim = columns.find((c) => c.role === 'dimension')
    if (firstDim) return `\norder by ${byKey.get(firstDim.key)} asc nulls last`
    return ''
  }
  if (source.defaultSort) {
    const field = sourceField(source, source.defaultSort.field)
    if (field) {
      const ord = byKey.get(field.key)
      if (ord) return `\norder by ${ord} ${source.defaultSort.dir} nulls last`
    }
  }
  return ''
}

function clampLimit(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return MAX_ROWS
  return Math.max(1, Math.min(MAX_ROWS, Math.trunc(raw)))
}

/** English fallback for an aggregated measure's column label. */
function defaultMeasureLabel(m: QueryMeasure, field: AnalyticsField | null): string {
  if (m.agg === 'count') return 'Count'
  const verb = m.agg === 'sum' ? 'Total' : m.agg[0].toUpperCase() + m.agg.slice(1)
  return `${verb} ${field?.label ?? ''}`.trim()
}

export { MAX_ROWS as INSIGHT_MAX_ROWS }
