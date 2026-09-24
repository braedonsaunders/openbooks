// The Insights SQL compiler: InsightQuery → parameterized Postgres.
//
// Security model (mirrors engine/src/platform/sqlapi.ts): every physical identifier comes
// from the authored catalog whitelist (source `from`, `orgColumn`, field `expr`)
// — NEVER from caller input. Callers only name catalog KEYS; the compiler looks
// each key up and fails closed on anything unknown. Every VALUE binds as a
// numbered ($1…) parameter. The org id is always ANDed into the WHERE as $1, so
// no query can escape its org. Output is a single SELECT ready for the read-only
// executor.

import { REPORT_ENTITY_MAP, SqlParams, averageSql, buildDenominationCensus, compileSubsidiaryScope, compileBookScope, customQueryReferencesBook, bindReportFromAsOf, compileRuleGroup, isBaseMoneyMeasure, isMoneyBlendingMeasure, isTxnCurrencyMeasure, reportBaseCurrencyPin, reportBookPin, reportTxnCurrencyPin, resolvePreset, type ReportBreakout, type ReportCustomQuery, type ReportEntity, type ReportMeasure, type ReportRule } from '@openbooks/reports'
import { sourceFromEntity } from './catalog'
import { buildSource, sourceField, type AnalyticsField, type AnalyticsSource } from './semantic'
import type {
  AggFn,
  CompiledQuery,
  DateBin,
  FilterOp,
  InsightDenominationBasis,
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
  | 'unknown_sort_ref'
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
      return averageSql(expr)
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
  /** The report entity backing the source — the reader's own catalog row, so
   *  a restricted reader's pre-collapsed grain flows into scope helpers. */
  entity: ReportEntity
  params: unknown[]
  /** Org business day (YYYY-MM-DD). Relative date filters bind this, never current_date. */
  asOf: string
  fiscalStartMonth: number
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
      if (op === 'in') return `${ref} = any(${bind(ctx, list)})`
      return `${ref} <> all(${bind(ctx, list)})`
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
    case 'this_year': {
      const range = resolvePreset('this_fiscal_year', {
        startMonth: ctx.fiscalStartMonth,
        today: ctx.asOf,
      })!
      return `${ref} >= ${bind(ctx, range.from)}::date and ${ref} < (${bind(ctx, range.to)}::date + interval '1 day')`
    }
    case 'ytd': {
      const range = resolvePreset('this_fiscal_year_to_date', {
        startMonth: ctx.fiscalStartMonth,
        today: ctx.asOf,
      })!
      return `${ref} >= ${bind(ctx, range.from)}::date and ${ref} <= ${bind(ctx, range.to)}::date`
    }
    default:
      throw new InsightCompileError('unknown_operator', `unknown filter operator "${op as string}"`, op as string)
  }
}

/** Adapt an insight plan to the report plan shape the shared basis helpers
 *  read. Insight filters are a flat AND list, so they become a single AND
 *  group; dimensions become breakouts (bins ride along so a binned temporal
 *  dimension is never mistaken for a denomination partition). Only `eq`/`in`
 *  survive the mapping — every other operator maps to the conservative `neq`,
 *  which scopes rows but never certifies a single denomination. The shared
 *  walkers only ever read fields (references check) and eq/in-single pins, so
 *  the mapping preserves their exact semantics. */
function toReportPlan(query: InsightQuery): ReportCustomQuery {
  return {
    entity: query.source,
    mode: 'summarize',
    columns: [],
    breakouts: (query.dimensions ?? []).map(
      (d) => ({ column: d.field, ...(d.bin ? { bin: d.bin } : {}) }) as ReportBreakout,
    ),
    measures: toReportMeasures(query),
    filters: {
      combinator: 'and',
      rules: (query.filters ?? []).map(
        (f) =>
          ({
            field: f.field,
            op: f.op === 'eq' || f.op === 'in' ? f.op : 'neq',
            value: f.value,
          }) as unknown as ReportRule,
      ),
    },
    groupBy: null,
  }
}

/** Insight measures in the report plan shape the denomination classifiers
 *  read. Catalog keys are shared verbatim between the two catalogs (the
 *  insight catalog projects report columns key-for-key), so the report
 *  entity's own txnCurrency/baseMoney flags classify each measure. */
function toReportMeasures(query: InsightQuery): ReportMeasure[] {
  return (query.measures ?? []).map((m) =>
    m.agg === 'count' || !m.field ? { fn: 'count' } : { fn: m.agg, column: m.field },
  )
}

/** True when the card explicitly scopes or partitions by accounting book — a
 *  filter or dimension on a book column. SHARES the report executor's rule
 *  (same REPORT_BOOK_KEYS, same customQueryReferencesBook): the author's own
 *  book scoping governs instead of the primary-book default. The web layer
 *  uses this to decide the book allowlist; the compiler only applies it. */
export function insightQueryReferencesBook(query: InsightQuery): boolean {
  return customQueryReferencesBook(toReportPlan(query))
}

/** The source's authored implicit predicate (e.g. "only active tiers"), shared
 *  verbatim with the report executor: the same catalog `baseFilter` compiled by
 *  the same rule compiler, with its bind params numbered after the org id. */
function compileBaseFilter(ctx: Ctx): string | null {
  const baseFilter = ctx.source.baseFilter
  if (!baseFilter) return null
  const entity = ctx.entity
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
 *  `labels` localizes the display labels baked into the column plan; an empty
 *  resolver falls back to the authored English. */
export function compileInsightQuery(
  query: InsightQuery,
  orgId: string,
  labels: InsightLabelResolver,
  asOf: string,
  allowedSubsidiaryIds: readonly string[] | null,
  /** Server-owned accounting-book allowlist, resolved by the caller (the
   *  single active primary unless the card scopes or partitions by book).
   *  Shared compileBookScope with the report executor: null/undefined leaves
   *  book-scoped entities unclamped, an empty array matches nothing.
   *  Book-independent sources ignore it. */
  allowedBookIds: readonly string[] | null | undefined = undefined,
  /** The reader's own report-entity catalog row (a restricted reader's
   *  pre-collapsed grain). The insight source derives from it, so payroll
   *  legs arrive collapsed before any caller filter, dimension, sort, or
   *  limit. Defaults to the authored catalog (full detail). */
  entityMap: Record<string, ReportEntity> = REPORT_ENTITY_MAP,
  fiscalStartMonth = 1,
): CompiledQuery {
  const entity = entityMap[query.source]
  if (!entity || entity.key !== query.source)
    throw new InsightCompileError('unknown_source', `unknown source "${query.source}"`, query.source)
  const source = buildSource(sourceFromEntity(entity))
  const fieldLabel = (f: AnalyticsField) => labels.field?.(source.key, f) ?? f.label

  const ctx: Ctx = { source, entity, params: [orgId], asOf, fiscalStartMonth }
  const wheres: string[] = [`${source.orgColumn} = $1`]
  const subsidiary = compileSubsidiaryScope(entity, allowedSubsidiaryIds, (value) => bind(ctx, value))
  if (subsidiary) wheres.push(subsidiary)
  const book = compileBookScope(entity, allowedBookIds, (value) => bind(ctx, value))
  if (book) wheres.push(book)
  const base = compileBaseFilter(ctx)
  if (base) wheres.push(base)
  for (const f of query.filters ?? []) wheres.push(compileFilter(ctx, f))

  // Denomination analysis — the SAME rule as custom-report summarize plans
  // (compileSummarize): which money the plan blends, and what already
  // certifies a single denomination without touching the database — static
  // filter pins, the server book clamp, or a single-subsidiary scope (one
  // subsidiary owns one base_currency). Anything still open is measured at
  // run time by an exact COUNT(DISTINCT) probe over the plan's own
  // FROM/WHERE, enforced by the executor before any blended row materializes.
  const reportPlan = toReportPlan(query)
  const reportMeasures = reportPlan.measures ?? []
  const txnMeasures = reportMeasures.filter((m) => isTxnCurrencyMeasure(entity, m))
  const baseMeasures = reportMeasures.filter((m) => isBaseMoneyMeasure(entity, m))
  const moneyMeasures = reportMeasures.filter((m) => isMoneyBlendingMeasure(entity, m))
  const txnCurrencyPinned = txnMeasures.length > 0 ? reportTxnCurrencyPin(entity, reportPlan) : null
  const baseCurrencyPinned = baseMeasures.length > 0 ? reportBaseCurrencyPin(entity, reportPlan) : null
  const bookPinned = moneyMeasures.length > 0 ? reportBookPin(entity, reportPlan) : null
  const bookSingleBasis = !!entity.bookScope && allowedBookIds != null && allowedBookIds.length <= 1
  const baseSingleSubsidiary = !!entity.baseCurrencyColumn
    && allowedSubsidiaryIds != null && allowedSubsidiaryIds.length === 1
  const census = buildDenominationCensus(entity, {
    txn: txnMeasures.length > 0 && !txnCurrencyPinned,
    base: baseMeasures.length > 0 && !baseCurrencyPinned && !baseSingleSubsidiary,
    book: moneyMeasures.length > 0 && !bookSingleBasis && !bookPinned,
  })
  const denomination: InsightDenominationBasis = {
    breakouts: reportPlan.breakouts ?? [],
    measures: reportMeasures,
    txnCurrencyPinned,
    baseCurrencyPinned,
    bookPinned,
    bookSingleBasis,
    baseSingleSubsidiary,
    hasDenominationCensus: census.censusRefs.length > 0,
    denominationDimensions: census.dimensions,
  }

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
        dateBin: dim.bin && r.field.canBin ? dim.bin : undefined,
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

  // Sort refs name output aliases, but authored plans (including the seeded
  // dashboard cards) name the catalog FIELD — `sort: [{ref:'posting_date'}]`
  // on a month-binned dimension. The binned alias (`posting_date_month`)
  // never equals the field, so an alias-only lookup silently drops the sort
  // and the query falls back to measure-desc: a twelve-month line renders in
  // revenue order instead of calendar order. Resolve field keys to their
  // output ordinal; aliases still win on collision.
  const fieldOrd = new Map<string, number>()
  if (isAggregate) {
    dimensions.forEach((d, i) => {
      if (!fieldOrd.has(d.field)) fieldOrd.set(d.field, i + 1)
    })
    measures.forEach((m, j) => {
      if (m.agg !== 'count' && m.field && !fieldOrd.has(m.field))
        fieldOrd.set(m.field, dimensions.length + j + 1)
    })
  }

  const orderBy = compileOrderBy(query, columns, fieldOrd, source, isAggregate)

  // The inline denomination census rides on the result rows: guard and result
  // derive from the same statement and snapshot — no separate preflight a
  // concurrent insertion could slip between. Every COUNT(DISTINCT) shares the
  // main query's bound parameters.
  const from = bindReportFromAsOf(source.from, ctx.asOf, (value) => bind(ctx, value))
  const where = wheres.join(' and ')
  const sql =
    `${census.censusCTE(from, where)}` +
    `select ${[...selects, ...census.censusRefs, ...census.bookGroupCount].join(', ')}\n` +
    `from ${from}\n` +
    `where ${where}` +
    groupBy +
    orderBy +
    `\nlimit ${limit}`

  return {
    sql,
    params: ctx.params,
    columns,
    limit,
    denomination,
  }
}

function compileOrderBy(
  query: InsightQuery,
  columns: ResultColumn[],
  fieldOrd: Map<string, number>,
  source: AnalyticsSource,
  isAggregate: boolean,
): string {
  const byKey = new Map(columns.map((c, i) => [c.key, i + 1]))
  const parts: string[] = []
  for (const s of query.sort ?? []) {
    // Output aliases first (existing plans keep meaning), then catalog field
    // keys. A stale explicit ref must refuse: falling back to a default can
    // change the ordering contract without telling the report's owner.
    const ord = byKey.get(s.ref) ?? fieldOrd.get(s.ref)
    if (!ord) {
      throw new InsightCompileError(
        'unknown_sort_ref',
        `sort reference '${s.ref}' no longer resolves — choose a current output column or catalog field`,
        s.ref,
      )
    }
    parts.push(`${ord} ${s.dir === 'asc' ? 'asc' : 'desc'} nulls last`)
  }
  if (parts.length > 0) return `\norder by ${parts.join(', ')}`

  // Sensible defaults: measure queries sort by the first measure desc; detail
  // queries follow the source default sort when that column is present.
  if (isAggregate) {
    // A TIME SERIES IS CHRONOLOGICAL, NOT A RANKING. Ranking by the measure is
    // the right default for "top customers by revenue"; applied to a
    // month-binned dimension it draws a twelve-month line in descending
    // revenue order, which always slopes down and says nothing about time.
    // A binned temporal dimension therefore orders by that dimension ascending
    // regardless of the measures present. An explicit sort still wins — this
    // block only runs when the plan named none, which is the case for every
    // card authored in the studio without touching the sort control.
    const firstTemporal = columns.find((c) => c.role === 'dimension' && c.dateBin)
    if (firstTemporal) return `\norder by ${byKey.get(firstTemporal.key)} asc nulls last`
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
  const verb = m.agg === 'sum' ? 'Total' : m.agg[0]!.toUpperCase() + m.agg.slice(1)
  return `${verb} ${field?.label ?? ''}`.trim()
}

export { MAX_ROWS as INSIGHT_MAX_ROWS }
