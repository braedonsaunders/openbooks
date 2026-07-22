// The Insights query model — a pragmatic, serializable JSON query compiled to
// parameterized Postgres against the authored catalog (./catalog.ts).
//
// Design: an enterprise card builder narrowed to a
// single-stage aggregate-or-detail query. Persisted as jsonb on
// `insight_cards.query`; compiled by ./compile.ts; executed by ./execute.ts.
//
// Injection safety: `source`, measure/dimension `field`s and filter `field`s
// are always catalog KEYS validated against the whitelist before a physical
// identifier is derived. Values ALWAYS bind as parameters. Pure types — no
// runtime — safe to import from client bundles.

// --- semantic vocabulary -----------------------------------------------------

/** How a catalog field is interpreted — drives which role it can play and how
 *  it is formatted / bucketed. */
export type SemanticType = 'date' | 'number' | 'currency' | 'category'

/** Aggregation a measure applies. `count` is COUNT(*) and needs no field. */
export type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max'

/** Date bucketing applied to a temporal dimension. */
export type DateBin = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Filter comparison operators. Value-taking ops bind parameters; the rest are
 *  self-contained (null checks + server-clock relative-date windows). */
export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'is_null',
  'is_not_null',
  // relative date windows, anchored to the server clock at compile time
  'last_n_days',
  'this_month',
  'this_quarter',
  'this_year',
  'ytd',
] as const
export type FilterOp = (typeof FILTER_OPS)[number]

// --- query shape -------------------------------------------------------------

export type QueryMeasure = {
  /** Catalog measure key. Omitted only for `agg: 'count'` (COUNT(*)). */
  field?: string
  agg: AggFn
  /** Output column key; unique within the query; whitelist-safe slug. Defaults
   *  are derived by the compiler when absent. */
  alias?: string
}

export type QueryDimension = {
  /** Catalog dimension key. */
  field: string
  /** Bucket a date dimension by calendar unit. Ignored for non-date fields. */
  bin?: DateBin
  /** Output column key; defaults to `field` (or `field_bin`). */
  alias?: string
}

export type QueryFilter = {
  /** Catalog field key (dimension OR measure — filters run pre-aggregation). */
  field: string
  op: FilterOp
  /** Bound as a parameter. Arrays for in/not_in; a number for last_n_days. */
  value?: string | number | boolean | Array<string | number> | null
}

export type QuerySort = {
  /** An output alias (measure or dimension) to order by. */
  ref: string
  dir: 'asc' | 'desc'
}

/** The complete, serializable insight query. Exactly one shape at a time:
 *  with `measures` it aggregates (grouped by `dimensions`); with neither it is
 *  a raw detail query returning the source's default columns. */
export type InsightQuery = {
  /** Catalog source key — validated against the catalog at compile time. */
  source: string
  measures?: QueryMeasure[]
  dimensions?: QueryDimension[]
  filters?: QueryFilter[]
  sort?: QuerySort[]
  /** Row cap for this query (hard-capped by the executor at 10k). */
  limit?: number | null
}

// --- viz spec ----------------------------------------------------------------

export const INSIGHT_VIZ_TYPES = ['table', 'bar', 'line', 'area', 'pie'] as const
export type VizType = (typeof INSIGHT_VIZ_TYPES)[number]

/** Per-card display settings persisted on `insight_cards.viz_settings`. */
export type VizSettings = {
  /** Dimension alias used as the category axis (bar/line/area/pie). Defaults to
   *  the first dimension. */
  categoryField?: string
  /** Measure aliases plotted as series. Defaults to every measure. */
  valueFields?: string[]
  /** Stack bar/area series. */
  stacked?: boolean
  /** Draw a horizontal bar chart. */
  horizontal?: boolean
  /** Smooth line/area curves. */
  smooth?: boolean
  /** Show data labels on marks. */
  showValues?: boolean
  /** Hide the legend (single-series charts). */
  hideLegend?: boolean
}

/** A resolved output column, with the formatting hint the renderer honors. */
export type ResultColumn = {
  key: string
  label: string
  /** Drives right-alignment + number/currency/date formatting. */
  type: SemanticType | 'text'
  role: 'dimension' | 'measure'
  /** Fixed value vocabulary ('yesNo' | 'activeInactive') the renderer
   *  localizes — set when the source field emits stable codes. */
  valueKind?: 'yesNo' | 'activeInactive'
}

/** The executed result set. */
export type QueryResult = {
  columns: ResultColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  durationMs: number
}

/** The compiled, ready-to-execute SQL + the column plan (so the executor can
 *  label + type results without re-deriving them). */
export type CompiledQuery = {
  sql: string
  params: unknown[]
  columns: ResultColumn[]
  /** The effective row cap applied to the SQL. */
  limit: number
}
