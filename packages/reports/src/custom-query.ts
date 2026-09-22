import { queryIdentifier } from './custom-record-entities'
// Compiler for user-built custom reports. SQL-injection-safe: every identifier
// comes from the server-resolved entity catalog and all filter values bind
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
  type ReportRule,
  type ReportRuleGroup,
} from './types'

export const DEFAULT_REPORT_LIMIT = 1000
/** Compatibility value for callers that need an explicit "full run" clamp.
 * It is the numeric/SQL safety boundary, not a product row ceiling. */
export const MAX_REPORT_ROWS = Number.MAX_SAFE_INTEGER
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
  /** Static single-denomination pins from the plan's filters (or null). The
   *  executor combines these with the observed probe census into effective
   *  single-ness for enforcement and shaping. */
  txnCurrencyPinned?: string | null
  baseCurrencyPinned?: string | null
  bookPinned?: string | null
  /** True when the server book clamp already restricts the run to one basis
   *  (singleton allowlist) or no rows (empty allowlist). */
  bookSingleBasis?: boolean
  /** True when a single-subsidiary scope already certifies one functional
   *  currency (one subsidiary owns one base_currency). */
  baseSingleSubsidiary?: boolean
  /** True when the compiled SELECT carries the inline `__denom` census
   *  (reserved `__txn_n`/`__base_n`/`__book_n` columns on every result row).
   *  False when every money dimension is already certified single (or the
   *  plan blends no money). */
  hasDenominationCensus?: boolean
  denominationDimensions?: ('txn' | 'base' | 'book')[]
  /** Exact same FROM/WHERE as `text`, used only when a nonzero offset returns
   *  no rows and therefore COUNT(*) OVER() has no carrier row. */
  countText?: string
}

export type CompileCustomQueryOpts = {
  /** Server-owned allowlist; an empty array grants no entity rows. */
  allowedSubsidiaryIds?: readonly string[] | null;
  /** Server-owned accounting-book allowlist for book-scoped entities (the
   *  executor resolves the single active primary by default). null/undefined
   *  leaves the entity unclamped for explicit cross-book analysis; an empty
   *  array matches nothing. Ignored by book-independent entities. */
  allowedBookIds?: readonly string[] | null;
  /** Optional caller-owned clamp (e.g. 200 for studio previews). */
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

/** Shared server-owned accounting-book policy for reports. Only entities
 *  that declare `bookScope` are clampable; book-independent sources (no
 *  book_id by design) ignore any allowlist so transaction balances stay
 *  book-agnostic. */
export function compileBookScope(
  entity: ReportEntity,
  allowedBookIds: readonly string[] | null | undefined,
  bind: (value: unknown) => string,
): string | null {
  if (allowedBookIds == null) return null
  if (!entity.bookScope) return null
  if (allowedBookIds.length === 0) return 'FALSE'
  return `${entity.bookScope.column} = ANY(${bind([...allowedBookIds])}::uuid[])`
}

/** Column keys that scope or partition the accounting basis. A plan that
 *  filters, breaks out, or sections by one runs unclamped: the author's own
 *  book scoping governs instead of the primary-book default. Selecting a book
 *  column for display alone does NOT lift the clamp. */
export const REPORT_BOOK_KEYS = ['book', 'book_code', 'book_id'] as const

function isRuleGroupNode(r: ReportRule | ReportRuleGroup): r is ReportRuleGroup {
  return typeof r === 'object' && r !== null && Array.isArray((r as ReportRuleGroup).rules)
}

/** True when the plan explicitly scopes or partitions by accounting book —
 *  a filter leaf on a book column, or a breakout/section on one. The check
 *  only READS the saved plan; it never rewrites a filter. */
export function customQueryReferencesBook(q: ReportCustomQuery): boolean {
  const walk = (node: ReportRuleGroup | null | undefined): boolean => {
    for (const r of node?.rules ?? []) {
      if (isRuleGroupNode(r)) {
        if (walk(r)) return true
      } else if ((REPORT_BOOK_KEYS as readonly string[]).includes(r.field)) {
        return true
      }
    }
    return false
  }
  if (walk(q.filters)) return true
  if (q.groupBy && (REPORT_BOOK_KEYS as readonly string[]).includes(q.groupBy)) return true
  return (q.breakouts ?? []).some((b) => (REPORT_BOOK_KEYS as readonly string[]).includes(b.column))
}

/** True when the measure aggregates a txn-currency money column (a value
 *  denominated in the row's transaction currency, not the org base). */
export function isTxnCurrencyMeasure(entity: ReportEntity, m: ReportMeasure): boolean {
  if (m.fn !== 'sum' && m.fn !== 'avg' && m.fn !== 'min' && m.fn !== 'max') return false
  if (!m.column) return false
  return entityColumn(entity, m.column)?.txnCurrency === true
}

/** True when the measure blends money across rows (any aggregate whose value
 *  mixes denominations or bases when buckets combine). Counts and distinct
 *  counts never blend. */
export function isMoneyBlendingMeasure(entity: ReportEntity, m: ReportMeasure): boolean {
  if (m.fn !== 'sum' && m.fn !== 'avg' && m.fn !== 'min' && m.fn !== 'max') return false
  if (!m.column) return false
  return entityColumn(entity, m.column)?.kind === 'money'
}

/** True when the measure aggregates functional-base money (GL base amounts
 *  stamped per line in the owning subsidiary's base_currency). */
export function isBaseMoneyMeasure(entity: ReportEntity, m: ReportMeasure): boolean {
  if (m.fn !== 'sum' && m.fn !== 'avg' && m.fn !== 'min' && m.fn !== 'max') return false
  if (!m.column) return false
  return entityColumn(entity, m.column)?.baseMoney === true
}

/** The single functional currency the plan's filters pin, or null. */
export function reportBaseCurrencyPin(entity: ReportEntity, q: ReportCustomQuery): string | null {
  return reportSingleValuePin(q, entity.baseCurrencyColumn)
}

/** Book columns that positively pin ONE accounting book when filtered with a
 *  single eq/in value. `book_id` and `book_code` are unique per org; the
 *  display name (`book`) is not schema-unique, so it scopes rows but never
 *  certifies a single basis for totals. */
const BOOK_PIN_KEYS = ['book_id', 'book_code'] as const

/** The single pinned book key value, or null. Positive AND-only eq/in-single
 *  filters on a unique book key pin; OR branches, negations, multi-value
 *  sets, and display-name filters do not — conservatively treated as open. */
export function reportBookPin(entity: ReportEntity, q: ReportCustomQuery): string | null {
  if (!entity.bookScope) return null
  const pinKeys = new Set<string>(BOOK_PIN_KEYS)
  let pinned: string | null = null
  let certain = true
  const leafValue = (rule: ReportRule): string | null => {
    if (!pinKeys.has(rule.field)) return null
    if (rule.op === 'eq' && typeof rule.value === 'string' && rule.value !== '') return rule.value
    if (rule.op === 'in' && Array.isArray(rule.value) && rule.value.length === 1 && typeof rule.value[0] === 'string') {
      return rule.value[0]
    }
    return null
  }
  const mentionsBook = (n: ReportRuleGroup): boolean =>
    n.rules.some((r) => (isRuleGroupNode(r) ? mentionsBook(r) : pinKeys.has(r.field)))
  const walk = (node: ReportRuleGroup | null | undefined): void => {
    if (!node || !certain) return
    if (node.not || node.combinator === 'or') {
      if (mentionsBook(node)) certain = false
      return
    }
    for (const r of node.rules) {
      if (isRuleGroupNode(r)) {
        walk(r)
      } else {
        const v = leafValue(r)
        if (v !== null) {
          if (pinned !== null && pinned !== v) certain = false
          pinned = v
        } else if (pinKeys.has(r.field)) {
          certain = false
        }
      }
      if (!certain) return
    }
  }
  walk(q.filters)
  return certain ? pinned : null
}

/** The single value the plan's filters pin a column to (eq/in with one value
 *  in a positive AND-only context), or null. OR branches, negations, and
 *  multi-value sets do not pin — conservatively treated as open. */
function reportSingleValuePin(q: ReportCustomQuery, key: string | undefined, pinKeys?: ReadonlySet<string>): string | null {
  const column = key
  if (!column) return null
  let pinned: string | null = null
  let certain = true
  const leafValue = (rule: ReportRule): string | null => {
    if (rule.field !== column) return null
    if (pinKeys && !pinKeys.has(rule.field)) return null
    if (rule.op === 'eq' && typeof rule.value === 'string' && rule.value !== '') return rule.value
    if (rule.op === 'in' && Array.isArray(rule.value) && rule.value.length === 1 && typeof rule.value[0] === 'string') {
      return rule.value[0]
    }
    return null
  }
  const mentions = (n: ReportRuleGroup): boolean =>
    n.rules.some((r) => (isRuleGroupNode(r) ? mentions(r) : r.field === column && (!pinKeys || pinKeys.has(r.field))))
  const walk = (node: ReportRuleGroup | null | undefined): void => {
    if (!node || !certain) return
    if (node.not || node.combinator === 'or') {
      // A negated or alternative branch cannot pin — but only matters when
      // it mentions the column at all.
      if (mentions(node)) certain = false
      return
    }
    for (const r of node.rules) {
      if (isRuleGroupNode(r)) {
        walk(r)
      } else {
        const v = leafValue(r)
        if (v !== null) {
          if (pinned !== null && pinned !== v) certain = false
          pinned = v
        } else if (r.field === column && (!pinKeys || pinKeys.has(r.field))) {
          certain = false
        }
      }
      if (!certain) return
    }
  }
  walk(q.filters)
  return certain ? pinned : null
}

/** The single transaction currency the plan's filters pin, or null. */
export function reportTxnCurrencyPin(entity: ReportEntity, q: ReportCustomQuery): string | null {
  return reportSingleValuePin(q, entity.currencyColumn)
}

/** The entity's implicit predicates: org scope + subsidiary/book allowlists
 *  + optional baseFilter. Lifting the book clamp (null allowlist) never
 *  touches the org or subsidiary fences. */
function implicitWhere(entity: ReportEntity, orgId: string, params: SqlParams, opts: CompileCustomQueryOpts): string[] {
  const parts = [`${entity.orgColumn} = ${params.add(orgId)}`]
  const subsidiary = compileSubsidiaryScope(entity, opts.allowedSubsidiaryIds, (value) => params.add(value))
  if (subsidiary) parts.push(subsidiary)
  const book = compileBookScope(entity, opts.allowedBookIds, (value) => params.add(value))
  if (book) parts.push(book)
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
    ...selectKeys.map((c) => `${columnRef(entity, c)} AS ${queryIdentifier(c)}`),
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

  // Denomination analysis: which money the plan blends, and what already
  // certifies a single denomination without touching the database —
  // static filter pins, the server book clamp, or a single-subsidiary scope
  // (one subsidiary owns one base_currency). Anything still open is measured
  // at run time by an exact COUNT(DISTINCT) probe over the plan's own
  // FROM/WHERE: legitimate single-denomination reports run untouched, while
  // actual mixed aggregates are refused before they materialize.
  const txnMeasures = measures.filter((m) => isTxnCurrencyMeasure(entity, m))
  const baseMeasures = measures.filter((m) => isBaseMoneyMeasure(entity, m))
  const moneyMeasures = measures.filter((m) => isMoneyBlendingMeasure(entity, m))
  const txnCurrencyPinned = txnMeasures.length > 0 ? reportTxnCurrencyPin(entity, q) : null
  const baseCurrencyPinned = baseMeasures.length > 0 ? reportBaseCurrencyPin(entity, q) : null
  const bookPinned = moneyMeasures.length > 0 ? reportBookPin(entity, q) : null
  const bookSingleBasis = !!entity.bookScope && opts.allowedBookIds != null && opts.allowedBookIds.length <= 1
  const baseSingleSubsidiary = !!entity.baseCurrencyColumn
    && opts.allowedSubsidiaryIds != null && opts.allowedSubsidiaryIds.length === 1

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

  // Inline denomination census: one CTE over the plan's own FROM/WHERE,
  // referenced per result row. Guard and result derive from the SAME SQL
  // snapshot — no separate preflight that a concurrent insertion could slip
  // between. Only still-open money dimensions are censused; every
  // COUNT(DISTINCT) shares the main query's bound parameters.
  const censusInner: string[] = []
  const txnRef = entity.currencyColumn ? columnRef(entity, entity.currencyColumn) : null
  if (txnMeasures.length > 0 && !txnCurrencyPinned && txnRef) {
    censusInner.push(`COUNT(DISTINCT ${txnRef}) AS "txn_n"`, `MIN(${txnRef}) AS "txn_v"`)
  }
  const baseRef = entity.baseCurrencyColumn ? columnRef(entity, entity.baseCurrencyColumn) : null
  if (baseMeasures.length > 0 && !baseCurrencyPinned && !baseSingleSubsidiary && baseRef) {
    censusInner.push(`COUNT(DISTINCT ${baseRef}) AS "base_n"`, `MIN(${baseRef}) AS "base_v"`)
  }
  if (moneyMeasures.length > 0 && entity.bookScope && !bookSingleBasis && !bookPinned) {
    censusInner.push(`COUNT(DISTINCT ${entity.bookScope.column}) AS "book_n"`, `MIN(${entity.bookScope.column}::text) AS "book_v"`)
  }
  // Reserved census aliases — no catalog column may use the __ prefix, so a
  // plan can never select over them.
  const censusRefs = [
    ['txn_n', 'txn_v'],
    ['base_n', 'base_v'],
    ['book_n', 'book_v'],
  ]
    .filter(([n]) => censusInner.some((part) => part.includes(`AS "${n}"`)))
    .flatMap(([n, v]) => [`(SELECT "${n}" FROM __denom) AS "__${n}"`, `(SELECT "${v}" FROM __denom) AS "__${v}"`])
  const censusCTE = censusInner.length > 0
    ? `WITH __denom AS (SELECT ${censusInner.join(', ')} FROM ${from} WHERE ${whereParts.join(' AND ')}) `
    : ''

  const bookGroupCount = censusInner.some((part) => part.includes('AS "book_n"'))
    ? [`COUNT(DISTINCT ${entity.bookScope!.column}) AS "__book_group_n"`]
    : []
  const text = [
    `${censusCTE}SELECT ${[...dimSelect, ...measSelect, ...censusRefs, ...bookGroupCount].join(', ')}`,
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
    txnCurrencyPinned,
    baseCurrencyPinned,
    bookPinned,
    bookSingleBasis,
    baseSingleSubsidiary,
    hasDenominationCensus: censusRefs.length > 0,
    denominationDimensions: (['txn', 'base', 'book'] as const).filter((dim) =>
      censusInner.some((part) => part.includes(`AS "${dim}_n"`))),
  }
}

/** One exact denomination census, read from the inline `__denom` columns of
 *  a result row. Guard and result rows come from the same statement, hence
 *  the same snapshot — a concurrent insertion cannot slip between them. */
export type DenominationCounts = {
  txn?: { distinct: number; sample: string | null }
  base?: { distinct: number; sample: string | null }
  book?: { distinct: number; sample: string | null }
}

/** Per-denomination single-ness for the result shaper: a summary-band total
 *  over a measure is honest only when its denominations are all single. */
export type DenominationSingles = { txn: boolean; base: boolean; book: boolean }

function parseProbeCount(value: unknown): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER
}

/** Parse the inline census columns of one result row into exact
 *  per-dimension counts. A missing census (no rows, or a plan that carries
 *  none) yields no observations; unparseable counts fail closed (treated as
 *  mixed, never as single). */
export function parseDenominationCounts(row: Record<string, unknown> | null | undefined): DenominationCounts {
  const out: DenominationCounts = {}
  const dims = [['txn', '__txn_n', '__txn_v'], ['base', '__base_n', '__base_v'], ['book', '__book_n', '__book_v']] as const
  for (const [dim, countKey, sampleKey] of dims) {
    if (row == null || !(countKey in row)) continue
    const sample = row[sampleKey]
    out[dim] = {
      distinct: parseProbeCount(row[countKey]),
      sample: typeof sample === 'string' && sample !== '' ? sample : null,
    }
  }
  return out
}

function hasEffectiveTotals(totals: ReportCustomQuery['totals']): boolean {
  return !!totals && (!!totals.sections || !!totals.grand || (totals.derived?.length ?? 0) > 0)
}

/** Fail-closed denomination enforcement over static pins, server clamps,
 *  and the observed probe census. Returns per-denomination single-ness for
 *  the shaper; throws BEFORE any blended row or combined total materializes:
 *  a dimension with several denominations and no partitioning breakout would
 *  blend inside single group rows, while section/grand/derived totals
 *  re-combine breakout buckets and need every blended dimension single.
 *  Partitions keep labeled per-denomination rows flowing — only the combining
 *  outputs are gated. Org, subsidiary, and book-clamp fences are ANDed
 *  upstream and untouched here. */
export function resolveDenominations(
  entity: ReportEntity,
  compiled: {
    breakouts?: ReportBreakout[]
    measures?: ReportMeasure[]
    totals?: ReportCustomQuery['totals']
    txnCurrencyPinned?: string | null
    baseCurrencyPinned?: string | null
    bookPinned?: string | null
    bookSingleBasis?: boolean
    baseSingleSubsidiary?: boolean
  },
  observed: DenominationCounts,
): DenominationSingles {
  const single = (
    dim: 'txn' | 'base' | 'book',
    staticPin: string | null | undefined,
    basisSingle?: boolean,
  ): boolean => {
    if (staticPin) return true
    if (basisSingle) return true
    const obs = observed[dim]
    if (!obs) return true
    return obs.distinct <= 1
  }
  const singles: DenominationSingles = {
    txn: single('txn', compiled.txnCurrencyPinned),
    base: single('base', compiled.baseCurrencyPinned, compiled.baseSingleSubsidiary),
    book: single('book', compiled.bookPinned, compiled.bookSingleBasis),
  }
  const partitioned = (keys: readonly string[]): boolean =>
    (compiled.breakouts ?? []).some((b) => !b.bin && (keys as readonly string[]).includes(b.column))
  const check = (
    measures: ReportMeasure[],
    isSingle: boolean,
    breakoutKeys: readonly string[],
    blendNoun: string,
    breakoutLabel: string,
  ): void => {
    if (measures.length === 0 || isSingle) return
    const firstLabel = measureLabel(entity, measures[0]!)
    if (!partitioned(breakoutKeys)) {
      throw new Error(
        `Cannot aggregate '${firstLabel}': rows mix ${blendNoun} — group by ${breakoutLabel} or filter to one`,
      )
    }
    if (hasEffectiveTotals(compiled.totals)) {
      throw new Error(
        `Report totals cannot combine ${blendNoun} — filter to one to total`,
      )
    }
  }
  const measures = compiled.measures ?? []
  check(
    measures.filter((m) => isTxnCurrencyMeasure(entity, m)),
    singles.txn,
    entity.currencyColumn ? [entity.currencyColumn] : [],
    'transaction currencies',
    'Currency',
  )
  check(
    measures.filter((m) => isBaseMoneyMeasure(entity, m)),
    singles.base,
    entity.baseCurrencyColumn ? [entity.baseCurrencyColumn] : [],
    'functional currencies',
    'Base currency',
  )
  check(
    measures.filter((m) => isMoneyBlendingMeasure(entity, m)),
    singles.book,
    REPORT_BOOK_KEYS,
    'accounting books',
    'Book',
  )
  return singles
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
  let limit = normalizeReportLimit(requested)
  if (Number.isFinite(maxRows) && Number(maxRows) > 0) {
    limit = Math.min(limit, normalizeReportLimit(maxRows))
  }
  return limit
}

/**
 * Normalize an untrusted requested result size without imposing an arbitrary
 * product-wide ceiling. Preview, export, and delivery callers may still pass
 * an explicit operational clamp; a full report otherwise honours its saved
 * row limit up to JavaScript/Postgres' shared safe-integer boundary.
 */
export function normalizeReportLimit(
  requested: number | null | undefined,
  fallback = DEFAULT_REPORT_LIMIT,
): number {
  const requestedNumber = Number(requested ?? fallback)
  const fallbackNumber = Number(fallback)
  const n = Number.isFinite(requestedNumber)
    ? requestedNumber
    : Number.isFinite(fallbackNumber)
      ? fallbackNumber
      : DEFAULT_REPORT_LIMIT
  return Math.min(Math.max(Math.trunc(n), 1), Number.MAX_SAFE_INTEGER)
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
  const configuredMax = normalizeReportLimit(entity.pagination.maxPageSize, 1)
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
