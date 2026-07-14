// The Insights SQL compiler: InsightQuery → parameterized Postgres.
//
// Security model (mirrors engine/src/sqlapi.ts): every physical identifier comes
// from the authored catalog whitelist (source `from`, `orgColumn`, field `expr`)
// — NEVER from caller input. Callers only name catalog KEYS; the compiler looks
// each key up and fails closed on anything unknown. Every VALUE binds as a
// numbered ($1…) parameter. The org id is always ANDed into the WHERE as $1, so
// no query can escape its org. Output is a single SELECT ready for the read-only
// executor.

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

export class InsightCompileError extends Error {
  readonly name = 'InsightCompileError'
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
  if (!expr) throw new InsightCompileError(`aggregation "${agg}" requires a field`)
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
      throw new InsightCompileError(`unknown aggregation "${agg}"`)
  }
}

/** date_trunc wrapper for a temporal dimension bin. */
function binSql(expr: string, bin: DateBin): string {
  if (!DATE_BINS.includes(bin)) throw new InsightCompileError(`unknown date bin "${bin}"`)
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
}

/** Push a bound value and return its `$n` placeholder. */
function bind(ctx: Ctx, value: unknown): string {
  ctx.params.push(value)
  return `$${ctx.params.length}`
}

function compileFilter(ctx: Ctx, filter: QueryFilter): string {
  const field = sourceField(ctx.source, filter.field)
  if (!field) throw new InsightCompileError(`unknown filter field "${filter.field}"`)
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
      if (typeof v !== 'string') throw new InsightCompileError('"contains" needs a text value')
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
      if (!Number.isFinite(n) || n < 0) throw new InsightCompileError('"within last N days" needs a number')
      return `${ref} >= (current_date - ${bind(ctx, Math.trunc(n))}::int)`
    }
    case 'this_month':
      return `${ref} >= date_trunc('month', current_date)::date and ${ref} < (date_trunc('month', current_date) + interval '1 month')::date`
    case 'this_quarter':
      return `${ref} >= date_trunc('quarter', current_date)::date and ${ref} < (date_trunc('quarter', current_date) + interval '3 months')::date`
    case 'this_year':
      return `${ref} >= date_trunc('year', current_date)::date and ${ref} < (date_trunc('year', current_date) + interval '1 year')::date`
    case 'ytd':
      return `${ref} >= date_trunc('year', current_date)::date and ${ref} <= current_date`
    default:
      throw new InsightCompileError(`unknown filter operator "${op as string}"`)
  }
}

function resolveDimension(source: AnalyticsSource, dim: QueryDimension): { expr: string; alias: string; field: AnalyticsField } {
  const field = sourceField(source, dim.field)
  if (!field) throw new InsightCompileError(`unknown dimension "${dim.field}"`)
  if (!field.canDimension) throw new InsightCompileError(`"${dim.field}" cannot be a dimension`)
  const binned = dim.bin && field.canBin
  const expr = binned ? binSql(field.expr, dim.bin!) : field.expr
  const alias = safeAlias(dim.alias, binned ? `${field.key}_${dim.bin}` : field.key)
  return { expr, alias, field }
}

function resolveMeasure(source: AnalyticsSource, m: QueryMeasure): { expr: string; alias: string; field: AnalyticsField | null } {
  if (!AGG_FNS.includes(m.agg)) throw new InsightCompileError(`unknown aggregation "${m.agg}"`)
  if (m.agg === 'count') {
    return { expr: 'count(*)', alias: safeAlias(m.alias, 'count'), field: null }
  }
  const field = sourceField(source, m.field ?? '')
  if (!field) throw new InsightCompileError(`unknown measure field "${m.field}"`)
  if (!field.canMeasure) throw new InsightCompileError(`"${m.field}" is not a numeric measure`)
  return {
    expr: aggSql(m.agg, field.expr),
    alias: safeAlias(m.alias, `${m.agg}_${field.key}`),
    field,
  }
}

/** Compile an InsightQuery into parameterized SQL + the output column plan. */
export function compileInsightQuery(query: InsightQuery, orgId: string): CompiledQuery {
  const source = getSource(query.source)
  if (!source) throw new InsightCompileError(`unknown source "${query.source}"`)

  const ctx: Ctx = { source, params: [orgId] }
  const wheres: string[] = [`${source.orgColumn} = $1`]
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
      columns.push({ key: alias, label: field.label, type: field.semanticType, role: 'dimension' })
    }
  } else {
    for (const dim of dimensions) {
      const r = resolveDimension(source, dim)
      const alias = uniq(r.alias)
      selects.push(`${r.expr} as "${alias}"`)
      columns.push({ key: alias, label: dimLabel(r.field, dim.bin), type: r.field.semanticType, role: 'dimension' })
    }
    for (const m of measures) {
      const r = resolveMeasure(source, m)
      const alias = uniq(r.alias)
      selects.push(`${r.expr} as "${alias}"`)
      columns.push({ key: alias, label: measureLabel(m, r.field), type: measureType(m.agg, r.field), role: 'measure' })
    }
  }

  if (selects.length === 0) throw new InsightCompileError('query selects no columns')

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

function dimLabel(field: AnalyticsField, bin: DateBin | undefined): string {
  return bin && field.canBin ? `${field.label} (${bin})` : field.label
}

function measureLabel(m: QueryMeasure, field: AnalyticsField | null): string {
  if (m.agg === 'count') return 'Count'
  const verb = m.agg === 'sum' ? 'Total' : m.agg[0].toUpperCase() + m.agg.slice(1)
  return `${verb} ${field?.label ?? ''}`.trim()
}

export { MAX_ROWS as INSIGHT_MAX_ROWS }
