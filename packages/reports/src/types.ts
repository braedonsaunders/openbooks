// Canonical vendor-neutral types for the custom-report engine.
//
// The query-plan types here are THE source of truth. schema/src/reporting.ts
// carries structurally-identical mirrors on its jsonb columns so the schema
// package stays dependency-free — keep the two in sync if operators change.

// --- Filter tree -------------------------------------------------------------

/** Operators a custom-report filter clause can use. */
export const REPORT_FILTER_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gte",
  "lte",
  "is_null",
  "is_not_null",
  // Boolean column tests (no value) — booleans surface as enum-kind columns.
  "is_true",
  "is_false",
  "contains",
  "between_days_ago",
  // Forward window: col on/before now + N days (includes overdue) — drives
  // "coming due / expiring soon" reports.
  "due_within_days",
  // Relative-date operators (no value) bind the executing organization's
  // declared civil date, independently of database host timezone or clock.
  "since_today",
  "this_week",
  "this_month",
  "this_year",
  "before_now",
  // Fiscal-aware period preset (value = a PERIOD_PRESETS id, e.g.
  // 'this_fiscal_year'). Unlike the calendar-only ops above, this respects the
  // org's fiscal start month. It is RESOLVED to concrete gte/lte bounds by the
  // web executor before the plan reaches the (DB-free) compiler; if it ever
  // reaches compileRule unresolved the group compiler throws rather than
  // dropping the date bounds and running unfiltered.
  "period_preset",
] as const;
export type ReportFilterOperator = (typeof REPORT_FILTER_OPERATORS)[number];

/** Leaf clause in the nested filter tree. */
export type ReportRule = {
  field: string;
  op: ReportFilterOperator;
  value?: string | number | string[] | number[] | null;
};

/** Nested and/or filter tree produced by the report studio and compiled to SQL
 *  by this package. */
export type ReportRuleGroup = {
  combinator: "and" | "or";
  not?: boolean;
  rules: (ReportRule | ReportRuleGroup)[];
};

// --- Summarize mode ----------------------------------------------------------

/** Aggregate functions a Summarize-mode measure can use. */
// 'latest' = the value on the chronologically last underlying row (entity must
// declare latestOrderExpr) — running totals like payroll YTD end exactly, where
// max() would overstate after a net-negative period.
export const REPORT_AGG_FNS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
  "latest",
  "opening",
  "closing",
  "formula",
] as const;
export type ReportAggFn = (typeof REPORT_AGG_FNS)[number];

export type ReportFormulaExpr =
  | { ref: string }
  | { const: string }
  | { op: "+" | "-" | "*" | "/"; left: ReportFormulaExpr; right: ReportFormulaExpr };

export type ReportFormulaFormat = "ratio" | "percent" | "money" | "number";

export type ReportFormulaGuard = {
  measure: string;
  when: "zero" | "null";
  label: string;
};

/** Temporal buckets for a Summarize-mode breakout on a date/timestamp column.
 *  The `fiscal_*` bins bucket by the org's fiscal calendar (start month passed
 *  into the compiler) rather than the calendar year. */
export const REPORT_TEMPORAL_BINS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_period",
  "fiscal_quarter",
  "fiscal_year",
] as const;
export type ReportTemporalBin = (typeof REPORT_TEMPORAL_BINS)[number];

/** A group-by dimension in Summarize mode. A date/timestamp column can be
 *  bucketed by `bin` (e.g. month) before grouping. */
export type ReportBreakout = {
  column: string;
  bin?: ReportTemporalBin;
};

/** An aggregate column in Summarize mode. `column` is omitted only for `count`. */
export type ReportMeasure = {
  fn: ReportAggFn;
  column?: string;
  /** Stable reference used by formula measures. */
  key?: string;
  /** A measure-local filter, applied before this aggregate is calculated. */
  filter?: ReportRuleGroup;
  /** Formula-only typed expression. */
  expr?: ReportFormulaExpr;
  /** Formula-only output format. */
  format?: ReportFormulaFormat;
  /** Formula-only decimal places. Defaults by format. */
  scale?: number;
  /** Formula-only explanation used when the result is undefined. */
  undefinedLabel?: string;
  /** Formula-only conditions that make the result undefined. */
  guards?: ReportFormulaGuard[];
  /** Keep a component selected for formula evaluation but omit its result column. */
  hidden?: boolean;
  /** Optional display label; defaults to a humanised "<fn> of <column>". */
  label?: string;
};

// --- The query plan ----------------------------------------------------------

export type ReportCustomQuery = {
  /** Entity key — validated at runtime against the entity catalog. */
  entity: string;
  /** Explicit period ownership; null keeps a current-state report unfiltered. */
  periodField?: string | null;
  /**
   * The date a point-in-time entity (one declaring `asOfField`) is read as
   * of. Absent, the run's business date. Refused on any other entity.
   */
  asOf?: string;
  /** 'rows' (default) = detail rows; 'summarize' = GROUP BY breakouts + measures. */
  mode?: "rows" | "summarize";
  columns: string[];
  /** Summarize mode: group-by dimensions (with optional temporal bucketing). */
  breakouts?: ReportBreakout[];
  /** Summarize mode: aggregate columns. */
  measures?: ReportMeasure[];
  /** Canonical nested and/or filter tree. */
  filters?: ReportRuleGroup | null;
  /** Rows mode: bucket detail rows into titled sections by this column. */
  groupBy?: string | null;
  /** Ordered sort levels; the validator refuses plans above its configured
   *  limit. Summarize mode orders by the levels that name a breakout column
   *  (enum breakouts in their catalog option order) or a measure key. */
  sorts?: { column: string; direction: "asc" | "desc" }[] | null;
  /** Summarize mode: omit groups whose every aggregate measure is zero, so a
   *  point-in-time balance lists only the positions that exist on the date. */
  omitZeroRows?: boolean;
  /** Rows mode: per-column display-label overrides, keyed by column key. */
  columnLabels?: Record<string, string> | null;
  /** Requested result rows. Full runs honour this; previews apply their own clamp. */
  limit?: number | null;
  /** Sectioned-summarize totals: per-section subtotal rows at the first
   *  non-section breakout level, and/or a final Grand totals group across all
   *  sections. Sum-style measures total; latest/avg/min/max stay blank.
   *  `derived` rows combine level buckets arithmetically (e.g. Net pay =
   *  earnings − deductions), appended per section and to the grand group. */
  totals?: {
    sections?: boolean;
    grand?: boolean;
    derived?: {
      label: string;
      plus: { field: string; value: string };
      minus?: { field: string; value: string };
    }[];
  } | null;
};

// --- Layout (page setup for a printed/exported document) ---------------------

/** Paper sizes a report document can print on. */
const REPORT_PAPER_SIZES = ["letter", "a4", "legal"] as const;
export type ReportPaperSize = (typeof REPORT_PAPER_SIZES)[number];

/** Document densities: compact shrinks type and cell padding so more rows fit
 *  per page. */
export const REPORT_DENSITIES = ["standard", "compact"] as const;
export type ReportDensity = (typeof REPORT_DENSITIES)[number];

/** Per-definition page setup. A null layout means the default: landscape
 *  Letter, 15 mm margins, standard density, summary band shown. Stored today,
 *  consumed when a print/PDF pipeline lands (TODO seam). */
export type ReportLayoutConfig = {
  paperSize: ReportPaperSize;
  orientation: "portrait" | "landscape";
  /** Uniform page margin in millimetres. */
  marginMm: number;
  /** Print the key-figures summary band under the header. Default true. */
  showSummary?: boolean;
  /** Type/padding scale for the whole document. Default 'standard'. */
  density?: ReportDensity;
};

const DEFAULT_REPORT_LAYOUT: ReportLayoutConfig = {
  paperSize: "letter",
  orientation: "landscape",
  marginMm: 15,
  showSummary: true,
  density: "standard",
};

/** Whitelist/clamp a partial layout into a complete, safe one. */
export function resolveReportLayout(
  raw: Partial<ReportLayoutConfig> | null | undefined,
): ReportLayoutConfig {
  const paperSize = REPORT_PAPER_SIZES.includes(raw?.paperSize as never)
    ? (raw!.paperSize as ReportPaperSize)
    : DEFAULT_REPORT_LAYOUT.paperSize;
  const orientation = raw?.orientation === "portrait" ? "portrait" : "landscape";
  const margin = Number(raw?.marginMm);
  const marginMm = Number.isFinite(margin) ? Math.min(Math.max(margin, 5), 30) : 15;
  const density = raw?.density === "compact" ? "compact" : "standard";
  return { paperSize, orientation, marginMm, showSummary: raw?.showSummary !== false, density };
}

// --- Result shapes shared by every report consumer ---------------------------
// The same RunResult feeds the in-app results table, the CSV export, and any
// future scheduled-document pipeline — one shape, one rendered report.

export type ReportGroup = {
  /**
   * Structural role: 'results' = the single unsectioned result table (viewers
   * may hide its title), 'section' = one groupBy bucket, 'summary' = the
   * summarize-mode table. Render decisions key off this — never off the
   * (localized) title text.
   */
  kind: "results" | "section" | "summary";
  title: string;
  /** Optional second line under the group title (e.g. count or status). */
  subtitle?: string;
  /** Column headings (display labels). */
  columns: string[];
  /** Rows aligned to `columns`. Cell values are coerced to string. */
  rows: (string | number | null | undefined)[][];
  /** Explanations for undefined formula cells, aligned to `rows`; renderers
   *  may expose them as muted, accessible labels while exports retain text. */
  undefinedCells?: (string | null)[][];
  /** Per-column: format as currency in viewers (money-kind columns/measures). */
  money?: boolean[];
  /** Per money column, the currency its amounts are in, for spreadsheet
   *  number formats: see ReportMoneyCurrency. Absent (or null) means the
   *  report's own currency, the one viewers format money in. */
  moneyCurrencies?: (ReportMoneyCurrency | null)[];
  /** Per-column quantity typing for the columns that are not money: 'number'
   *  cells are exact decimal strings (or numbers) that viewers and print
   *  format per locale and spreadsheets store as numeric cells; 'percent'
   *  cells are percentage points (47.25 is 47.25%); 'per_share' cells are
   *  exact decimals read under the per-share rule. Text in such a column (an
   *  undefined-formula explanation) stays text. CSV keeps the exact,
   *  machine-readable value. */
  numberFormats?: (ReportNumberFormat | null)[];
  /** Per-column: the cells are ISO calendar dates (YYYY-MM-DD) that viewers
   *  and print read in the viewer's locale; CSV keeps the ISO date. */
  dates?: boolean[];
  /** Per-column alignment (text left, numeric/money right). Viewers fall back
   *  to first-column-left/rest-right when absent. */
  align?: ("left" | "right" | "center")[];
  /** For 'section' groups: the raw groupBy field + bucket value, so viewers
   *  can scope drill-downs to exactly this section's rows. */
  groupKey?: { field: string; value: string };
  /** Row indices styled as total/subtotal rows by viewers. */
  totalRows?: number[];
  /** Summarize mode: per-row scope of the aggregate — one entry per breakout
   *  (eq value, date range for binned buckets, or null-bucket marker). Rows
   *  whose bucket cannot be scoped exactly carry null (viewers omit the
   *  drill rather than show unrelated records). */
  rowKeys?: (ReportRowScopeRule[] | null)[];
  /** Optional native navigation target for each displayed cell. The matrix is
   *  aligned exactly to `rows`; null cells remain plain text. Link metadata is
   *  authored by the entity catalog and selected as hidden query columns, so
   *  viewers never have to infer a record id from formatted display values. */
  cellLinks?: (ReportCellLink | null)[][];
  /** If true, render an "empty" placeholder row instead of the table. */
  isEmpty?: boolean;
};

/** One exact-scope predicate for drilling into an aggregate bucket. */
export type ReportRowScopeRule =
  | { field: string; value: string }
  | { field: string; from: string; to: string }
  | { field: string; empty: true };

/**
 * The currency of one money column: a fixed ISO 4217 code; `{ column }`, the
 * index of the column carrying each row's currency code (transaction-currency
 * amounts exported beside their currency); or `'unstated'` when each row
 * carries its own transaction currency and that currency is not part of the
 * result, so a spreadsheet keeps the amount at its own precision without a
 * currency label rather than naming the wrong one.
 */
export type ReportMoneyCurrency = string | { column: number } | "unstated";

/**
 * How a non-money quantity column reads; see ReportGroup.numberFormats.
 * 'per_share' columns (prices and values per share or unit) read under the
 * per-share precision rule (per-share.ts) in viewers, print and spreadsheets.
 */
export type ReportNumberFormat = "number" | "percent" | "per_share";

/** One summary-band figure. `money` values format as currency; `number`
 *  values are exact decimal quantities formatted per locale. */
export type ReportSummaryItem = {
  label: string;
  value: string | number;
  money?: boolean;
  number?: boolean;
};

/** Native record navigation carried alongside a report cell. `entryId` is
 *  always present because the transaction link can also open a ledger entry
 *  that has no source document. For document-backed rows it may deliberately
 *  equal `docId` when no posted journal entry exists yet. */
export type ReportCellLink = {
  kind: "transaction";
  entryId: string;
  docId?: string | null;
  docKind?: string | null;
};

/** Requested slice of an entity whose catalog opts into paging. Values are
 *  normalized by the compiler; callers may pass untrusted URL numbers. */
export type ReportPageRequest = {
  offset: number;
  limit: number;
};

/** Page facts returned with a paged run. `totalRows` is the count under the
 *  exact same org scope and effective filter tree as the displayed rows. */
export type ReportPageInfo = {
  offset: number;
  limit: number;
  totalRows: number;
  hasNext: boolean;
  hasPrevious: boolean;
};

export type ReportRunResult = {
  groups: ReportGroup[];
  summary: ReportSummaryItem[];
  rowCount: number;
  pageInfo?: ReportPageInfo;
};

// --- Small shared formatting helpers ------------------------------------------

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function formatLabel(s: string): string {
  return (s ?? "").replace(/_/g, " ");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pickUuid(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return UUID_RE.test(v) ? v : null;
}
