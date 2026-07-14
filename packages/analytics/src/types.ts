// BHQL — the Insights query AST (ported from beaconhs).
//
// A serializable, stage-based structured query (Metabase-MBQL parity, narrowed
// to a single Postgres dialect). It is persisted as jsonb on `insight_cards.query`
// and compiled to SQL by @openbooks/analytics/server. Pure types — no runtime.
//
// The filter shape (`RuleGroup`) is shared by stage filters, conditional
// measures and dashboard-parameter injection.

// --- filter tree -------------------------------------------------------------

export const FILTER_OPERATOR_KEYS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gte',
  'lte',
  'is_null',
  'is_not_null',
  'is_true',
  'is_false',
  'contains',
  // Rolling window: col within the last N days.
  'between_days_ago',
  // Forward window: col on/before now + N days (includes overdue).
  'due_within_days',
  // Relative-date operators (no value) — anchored to the server clock at
  // compile time, so "this month" / "overdue" cards stay correct.
  'since_today',
  'this_week',
  'this_month',
  'this_year',
  'before_now',
] as const
export type FilterOperator = (typeof FILTER_OPERATOR_KEYS)[number]

/** Leaf clause in the nested filter tree. */
export type Rule = {
  field: string
  op: FilterOperator
  value?: string | number | string[] | number[] | null
}

/** Nested and/or filter tree produced by the card studio and compiled to SQL. */
export type RuleGroup = {
  combinator: 'and' | 'or'
  not?: boolean
  rules: (Rule | RuleGroup)[]
}

// --- BHQL AST -----------------------------------------------------------------

export type BhqlVersion = 'bhql/1'

/** Aggregation functions a measure can apply. `count` is COUNT(*). */
export type BhqlAggFn = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max'

/** A measure (aggregation) producing one output column. `field` is omitted only
 *  for `fn: 'count'` (COUNT(*)); every other function requires a field. */
export type BhqlMeasure = {
  kind?: 'agg'
  fn: BhqlAggFn
  field?: string
  /** Output column key; unique within a stage; whitelist-safe slug. */
  alias: string
  /** Conditional aggregate — only count/sum rows matching this sub-filter
   *  (compiles to `<agg> FILTER (WHERE …)`). */
  filter?: RuleGroup | null
}

/** A measure COMPUTED from other (base) measures — ratios, percentages, rates.
 *  `numerator / denominator * multiplier`. Referenced base measures must exist
 *  in the same stage. */
export type BhqlCalcMeasure = {
  kind: 'calc'
  alias: string
  /** Base measure alias. */
  numerator: string
  /** Base measure alias; omit for a plain scaled measure. */
  denominator?: string
  /** Scale factor (×100 for a percentage; default 1). */
  multiplier?: number
}

/** A custom-aggregation measure: an arbitrary expression that may contain
 *  aggregate nodes — e.g. `datediff('day', max(posting_date), now())`. */
export type BhqlExprMeasure = {
  kind: 'expr'
  alias: string
  expr: BhqlExpr
}

export type BhqlAnyMeasure = BhqlMeasure | BhqlCalcMeasure | BhqlExprMeasure

export type BhqlTemporalUnit = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** A computed expression over columns + literals — arithmetic, comparison,
 *  CASE, and a whitelisted function library (date math, string, math). Powers
 *  computed dimensions and custom aggregations, so derived values like "days
 *  since last posting" or an amount bucket are buildable in the UI with NO
 *  database view. Every function + column + operator is whitelisted before it
 *  reaches SQL. */
export type BhqlExpr =
  | { ex: 'field'; field: string }
  | { ex: 'lit'; value: string | number | boolean | null }
  | { ex: 'arith'; op: '+' | '-' | '*' | '/'; left: BhqlExpr; right: BhqlExpr }
  | { ex: 'compare'; op: '=' | '!=' | '<' | '<=' | '>' | '>='; left: BhqlExpr; right: BhqlExpr }
  | { ex: 'isnull'; arg: BhqlExpr; negated?: boolean }
  | { ex: 'logic'; op: 'and' | 'or' | 'not'; args: BhqlExpr[] }
  | { ex: 'case'; branches: { when: BhqlExpr; then: BhqlExpr }[]; else?: BhqlExpr }
  | { ex: 'call'; fn: string; args: BhqlExpr[] }
  | { ex: 'agg'; fn: BhqlAggFn; arg?: BhqlExpr; filter?: RuleGroup | null }

/** Bucketing applied to a breakout dimension. */
export type BhqlBin =
  | { kind: 'temporal'; unit: BhqlTemporalUnit }
  | { kind: 'numeric'; numBins: number }

/** A group-by dimension, optionally bucketed. Exactly one of `field` (a column
 *  ref) or `expr` (a computed expression) is set. */
export type BhqlBreakout = {
  field?: string
  /** A computed expression to group by, instead of a plain column. */
  expr?: BhqlExpr
  /** Output column key; unique within a stage; whitelist-safe slug. */
  alias: string
  bin?: BhqlBin
  /** Expand an array / jsonb-array column to one row per element, then group by
   *  the element. Mutually exclusive with `expr` and `bin`. */
  unnest?: 'array' | 'jsonb'
}

/** References into a stage's own breakouts/measures, by alias. */
export type BhqlBreakoutRef = { breakout: string }
export type BhqlMeasureRef = { measure: string }

export type BhqlPivotSubtotals = 'none' | 'rows' | 'both'

/** Pivot shaping: which breakouts go on the row axis vs column axis, and which
 *  measures fill the cells. Honored only when `display: 'pivot'`. */
export type BhqlPivot = {
  rows: BhqlBreakoutRef[]
  columns: BhqlBreakoutRef[]
  values: BhqlMeasureRef[]
  subtotals?: BhqlPivotSubtotals
}

export type BhqlOrderBy = {
  /** An output alias (a breakout/measure alias) or, in raw-row mode, a column key. */
  ref: string
  direction: 'asc' | 'desc'
}

/** Aligns a joined source to the primary grain: maps a primary-stage breakout
 *  (by alias) to the field on the joined source that supplies the same value,
 *  bucketed identically when the primary breakout is binned. */
export type BhqlJoinKey = {
  /** A primary-stage breakout alias. */
  breakout: string
  /** The field on the joined source that supplies the same grain value. */
  field: string
  /** Match the primary breakout's bin (e.g. both bucketed by month). */
  bin?: BhqlBin
}

/** An additional source, aggregated independently and FULL OUTER JOINed to the
 *  primary stage on the shared-grain breakout dimensions — cross-table ratios
 *  (e.g. AP spend ÷ document count) with NO database view. */
export type BhqlJoinedSource = {
  /** Entity key — validated against the catalog. */
  source: string
  filter?: RuleGroup | null
  /** Aggregates produced from THIS source. Aliases are unique across the query. */
  measures: BhqlMeasure[]
  /** Maps every primary breakout to a field on this source (the shared grain). */
  on: BhqlJoinKey[]
}

/** A dimension source in a spine — its cross-product with the other dimensions
 *  forms the row space. Columns are addressed as "<alias>.<column>". */
export type BhqlSpineSource = {
  alias: string
  source: string
  filter?: RuleGroup | null
}

/** A fact source LEFT-JOINed onto the spine, optionally reduced to the single
 *  latest row per spine key (a correlated LATERAL `ORDER BY … LIMIT 1`). */
export type BhqlSpineFact = {
  alias: string
  source: string
  filter?: RuleGroup | null
  /** Correlate to the spine: each fact field equals a spine field ref. */
  on: { field: string; equals: string }[]
  /** Reduce to one row per spine key by this ordering (omit = plain LEFT JOIN). */
  latestBy?: BhqlOrderBy[]
}

/** A fact-free dimension grid (cross-product of dimension sources) plus optional
 *  latest-fact joins — the generic form behind a coverage matrix, buildable with
 *  NO view. A spine's breakouts/measures address columns "<alias>.<column>". */
export type BhqlSpine = {
  dimensions: BhqlSpineSource[]
  facts?: BhqlSpineFact[]
}

/** One analysis stage. v1 emits exactly one. The array shape is forward-compat
 *  for post-aggregation stages without a jsonb migration. */
export type BhqlStage = {
  /** Entity key — validated at run time against the catalog. Ignored when
   *  `spine` is set (the spine defines the FROM). */
  source: string
  filter?: RuleGroup | null
  aggregations?: BhqlAnyMeasure[]
  breakouts?: BhqlBreakout[]
  /** Additional aggregated sources joined to the primary on the shared grain. */
  joinedSources?: BhqlJoinedSource[]
  /** A dimension cross-product + latest-fact joins (the coverage-matrix form). */
  spine?: BhqlSpine
  /** Raw-row mode (no aggregations/breakouts): entity columns to SELECT. */
  columns?: string[]
  orderBy?: BhqlOrderBy[]
  limit?: number | null
}

export type BhqlDisplay = 'table' | 'pivot'

export type BhqlQuery = {
  version: BhqlVersion
  stages: BhqlStage[]
  display: BhqlDisplay
  pivot?: BhqlPivot | null
}

// --- dashboard layout types (stored as jsonb on insight_dashboards) ----------

/** One placed card on a 12-column dashboard grid. `id` is an insight_cards.id. */
export type InsightDashboardWidget = {
  id: string
  x: number
  y: number
  w: number
  h: number
}
export type InsightDashboardLayout = { widgets: InsightDashboardWidget[] }

/** Dashboard-level filters that fan out into mapped cards' queries at run time. */
export type DashboardParamType = 'date' | 'text' | 'number' | 'enum'
export type DashboardParam = {
  key: string
  label: string
  type: DashboardParamType
  defaultValue?: string | number | null
}
/** paramKey → list of (cardId, field) the value is injected into as a filter. */
export type DashboardParamMapEntry = { cardId: string; field: string }
export type DashboardParamMap = Record<string, DashboardParamMapEntry[]>
