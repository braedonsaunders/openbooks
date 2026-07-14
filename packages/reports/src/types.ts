// Canonical types for the custom-report engine (ported from beaconhs
// packages/reports + packages/db/src/schema/reports.ts, vendor-neutral).
//
// The query-plan types here are THE source of truth. schema/src/reporting.ts
// carries structurally-identical mirrors on its jsonb columns so the schema
// package stays dependency-free — keep the two in sync if operators change.

// --- Filter tree -------------------------------------------------------------

/** Operators a custom-report filter clause can use. */
export const REPORT_FILTER_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gte',
  'lte',
  'is_null',
  'is_not_null',
  // Boolean column tests (no value) — booleans surface as enum-kind columns.
  'is_true',
  'is_false',
  'contains',
  'between_days_ago',
  // Forward window: col on/before now + N days (includes overdue) — drives
  // "coming due / expiring soon" reports.
  'due_within_days',
  // Relative-date operators (no value) — compiled to pure SQL anchored to the
  // DB clock, so "this month" reports stay correct without a parameter.
  'since_today',
  'this_week',
  'this_month',
  'this_year',
  'before_now',
] as const
export type ReportFilterOperator = (typeof REPORT_FILTER_OPERATORS)[number]

/** Leaf clause in the nested filter tree. */
export type ReportRule = {
  field: string
  op: ReportFilterOperator
  value?: string | number | string[] | number[] | null
}

/** Nested and/or filter tree produced by the report studio and compiled to SQL
 *  by this package. */
export type ReportRuleGroup = {
  combinator: 'and' | 'or'
  not?: boolean
  rules: (ReportRule | ReportRuleGroup)[]
}

// --- Summarize mode ----------------------------------------------------------

/** Aggregate functions a Summarize-mode measure can use. */
export const REPORT_AGG_FNS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const
export type ReportAggFn = (typeof REPORT_AGG_FNS)[number]

/** Temporal buckets for a Summarize-mode breakout on a date/timestamp column. */
export const REPORT_TEMPORAL_BINS = ['day', 'week', 'month', 'quarter', 'year'] as const
export type ReportTemporalBin = (typeof REPORT_TEMPORAL_BINS)[number]

/** A group-by dimension in Summarize mode. A date/timestamp column can be
 *  bucketed by `bin` (e.g. month) before grouping. */
export type ReportBreakout = {
  column: string
  bin?: ReportTemporalBin
}

/** An aggregate column in Summarize mode. `column` is omitted only for `count`. */
export type ReportMeasure = {
  fn: ReportAggFn
  column?: string
  /** Optional display label; defaults to a humanised "<fn> of <column>". */
  label?: string
}

// --- The query plan ----------------------------------------------------------

export type ReportCustomQuery = {
  /** Entity key — validated at runtime against the entity catalog. */
  entity: string
  /** 'rows' (default) = detail rows; 'summarize' = GROUP BY breakouts + measures. */
  mode?: 'rows' | 'summarize'
  columns: string[]
  /** Summarize mode: group-by dimensions (with optional temporal bucketing). */
  breakouts?: ReportBreakout[]
  /** Summarize mode: aggregate columns. */
  measures?: ReportMeasure[]
  /** Canonical nested and/or filter tree. */
  filters?: ReportRuleGroup | null
  /** Rows mode: bucket detail rows into titled sections by this column. */
  groupBy?: string | null
  /** Defaults to the entity's default sort. */
  sort?: { column: string; direction: 'asc' | 'desc' } | null
  /** Hard cap on rows (engine clamps to 10 000). */
  limit?: number | null
}

// --- Layout (page setup for a printed/exported document) ---------------------

/** Paper sizes a report document can print on. */
export const REPORT_PAPER_SIZES = ['letter', 'a4', 'legal'] as const
export type ReportPaperSize = (typeof REPORT_PAPER_SIZES)[number]

/** Document densities: compact shrinks type and cell padding so more rows fit
 *  per page. */
export const REPORT_DENSITIES = ['standard', 'compact'] as const
export type ReportDensity = (typeof REPORT_DENSITIES)[number]

/** Per-definition page setup. A null layout means the default: landscape
 *  Letter, 15 mm margins, standard density, summary band shown. Stored today,
 *  consumed when a print/PDF pipeline lands (TODO seam). */
export type ReportLayoutConfig = {
  paperSize: ReportPaperSize
  orientation: 'portrait' | 'landscape'
  /** Uniform page margin in millimetres. */
  marginMm: number
  /** Print the key-figures summary band under the header. Default true. */
  showSummary?: boolean
  /** Type/padding scale for the whole document. Default 'standard'. */
  density?: ReportDensity
}

export const DEFAULT_REPORT_LAYOUT: ReportLayoutConfig = {
  paperSize: 'letter',
  orientation: 'landscape',
  marginMm: 15,
  showSummary: true,
  density: 'standard',
}

/** Whitelist/clamp a partial layout into a complete, safe one. */
export function resolveReportLayout(raw: Partial<ReportLayoutConfig> | null | undefined): ReportLayoutConfig {
  const paperSize = REPORT_PAPER_SIZES.includes(raw?.paperSize as never)
    ? (raw!.paperSize as ReportPaperSize)
    : DEFAULT_REPORT_LAYOUT.paperSize
  const orientation = raw?.orientation === 'portrait' ? 'portrait' : 'landscape'
  const margin = Number(raw?.marginMm)
  const marginMm = Number.isFinite(margin) ? Math.min(Math.max(margin, 5), 30) : 15
  const density = raw?.density === 'compact' ? 'compact' : 'standard'
  return { paperSize, orientation, marginMm, showSummary: raw?.showSummary !== false, density }
}

// --- Result shapes shared by every report consumer ---------------------------
// The same RunResult feeds the in-app results table, the CSV export, and any
// future scheduled-document pipeline — one shape, one rendered report.

export type ReportGroup = {
  title: string
  /** Optional second line under the group title (e.g. count or status). */
  subtitle?: string
  /** Column headings (display labels). */
  columns: string[]
  /** Rows aligned to `columns`. Cell values are coerced to string. */
  rows: (string | number | null | undefined)[][]
  /** If true, render an "empty" placeholder row instead of the table. */
  isEmpty?: boolean
}

export type ReportSummaryItem = { label: string; value: string | number }

export type ReportRunResult = {
  groups: ReportGroup[]
  summary: ReportSummaryItem[]
  rowCount: number
}

// --- Small shared formatting helpers ------------------------------------------

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function formatLabel(s: string): string {
  return (s ?? '').replace(/_/g, ' ')
}

export function pickUuid(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return /^[0-9a-f-]{36}$/i.test(v) ? v : null
}
