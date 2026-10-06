import "server-only";
import { analyticsQuery } from "./query";
import { analyticsSection } from "./read-context";
import { sql } from "drizzle-orm";
import { addMonthsClamped, utcDateFromParts } from "@openbooks/engine/platform/civil-date";
import { abs, add, cmp, isZero, mulDecimal, neg, sum } from "@openbooks/engine/money";
import { canonicalDecimal, compareDecimal } from "@openbooks/engine/money/decimal";
import { flowRates } from "../fx-presentation";
import { defaultFiscalCalendarPeriods } from "../fiscal";
import type { FiscalPeriod } from "@openbooks/reports";
import { statementBookExpr } from "../gl-summary";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { financialHealth, type FinancialHealth, type HealthFigures, type HealthPnlFigures } from "./financial-health";
import { healthStrings, type HealthStrings } from "./health-strings";
import { englishCatalogMessage } from "./catalog-strings";
import { evaluateAnalyticsRatio } from "./analytics-ratio";
import { analyticsConfig } from "./config";
import { analyticsConfigSpec, FORECAST_ADJUSTMENTS } from "./config-spec";
import { isFeatureEnabled } from "../features";
import { OPERATING_EXPENSE_TYPES } from "./operating-expenses";
import { decimalRatio } from "../reports/decimals";
import { PNL_COST_TYPES, PNL_TYPES } from "../account-types";
import { getMoneyFormatter } from '../money-server'

/** The canonical operating-expense type list as a SQL `IN` fragment (one definition). */
const OPEX_TYPES_SQL = sql.join(
  OPERATING_EXPENSE_TYPES.map((t) => sql`${t}`),
  sql`, `,
);

/**
 * The formal P&L universe (and its cost side) as SQL `IN` fragments. These
 * are the single shared definition in lib/account-types — every breakdown
 * that claims to slice the P&L filters on these, so a slice always sums to
 * the headline. Never hand-write a type list for the P&L universe here.
 */
const PNL_TYPES_SQL = sql.join(
  PNL_TYPES.map((t) => sql`${t}`),
  sql`, `,
);
const PNL_COST_TYPES_SQL = sql.join(
  PNL_COST_TYPES.map((t) => sql`${t}`),
  sql`, `,
);

/**
 * Full data payload for the Financial Health dashboard — everything the 10
 * tabs need, sourced natively from the openbooks GL (+ invoice doc lines for
 * item revenue). built around the Lib_Health_Data.js shapes.
 *
 * Sign convention: journal amounts are debit-positive; income/credit-normal
 * types are flipped so revenue/margins read positive.
 */

export interface MonthPoint {
  month: string; // YYYY-MM
  label: string; // "Jan '25"
  /** Exact decimal strings; margins stay display numbers computed from integer units below. */
  revenue: string;
  cogs: string;
  grossProfit: string;
  /** Null without revenue: a share of nothing does not exist, never 0. */
  grossMarginPct: number | null;
  opex: string;
  operatingIncome: string;
  /** Null without revenue: a share of nothing does not exist, never 0. */
  operatingMarginPct: number | null;
  netIncome: string;
}

export interface PnlLine {
  key: string;
  label: string;
  /** Exact amounts in the presentation currency. */
  current: string;
  prior: string;
  change: string;
  /** Fraction of the prior magnitude; null without a prior figure. */
  changePct: string | null;
  strong?: boolean;
}

export interface MarginStage {
  key: string;
  label: string;
  /** The exact flow amount (revenue, −cogs, gp, −opex, opInc, net). */
  amount: string;
  /** Fraction of revenue; null when the period has no revenue. */
  pctOfRevenue: string | null;
  kind: "start" | "deduct" | "subtotal" | "total";
}

export interface SegmentRow {
  id: string;
  name: string;
  revenue: string;
  sharePct: number;
  grossProfit: string;
  grossMarginPct: number | null;
  operatingIncome: string;
  operatingMarginPct: number | null;
  yoyPct: number | null;
  /** Null without revenue: no margin exists to grade, so no dot is claimed. */
  health: "good" | "warn" | "bad" | null;
}

export interface DriverRow {
  id: string;
  name: string;
  type: string;
  current: string;
  prior: string;
  change: string;
  changePct: number | null;
  contribution: number; // share of total absolute movement
}

export interface ItemRow {
  id: string;
  name: string;
  prior: string;
  current: string;
  change: string;
  changePct: number | null;
  contribution: number;
}

export interface Insight {
  severity: "issue" | "rec" | "anomaly";
  title: string;
  detail: string;
}

export interface BudgetRow {
  accountId: string;
  name: string;
  type: string;
  budget: string;
  actual: string;
  variance: string; // actual − budget (income sign-normalised positive)
  /** Exact fraction of the budget magnitude; null without a budget. */
  variancePct: string | null;
  favorable: boolean;
  status: "on-track" | "watch" | "over" | "under" | "no-budget";
}

/** Budget status bands in percentage points, from organization configuration. */
export interface BudgetTolerance {
  onTrack: number;
  watch: number;
}

export interface BudgetVariance {
  scenario: { id: string; name: string; fiscalYear: number; status: string } | null;
  rows: BudgetRow[];
  totals: { budget: string; actual: string; variance: string };
  /** The configured tolerance bands behind every row status (for the disclosed note). */
  tolerance: BudgetTolerance;
}

/**
 * Client-needed configuration: every band a tab compares against, read once
 * on the server so no tab keeps its own copy of a threshold.
 */
export interface HealthBands {
  /** Segment concentration (HHI, 0–10,000 scale) warning/critical levels. */
  hhi: { warning: number; critical: number };
  /** Scenario safety margin: the thin-margin floor and the comfort level above breakeven, exact fractions. */
  scenario: { safety: string; comfort: string };
}

/** One macro-adjustment choice: its catalog code and its exact factor. */
export interface ForecastAdjustmentOption {
  code: string;
  value: number;
}

/**
 * The forecast model as the organization configured it: defaults, offered
 * choices (from the threshold spec, the single source of truth) and model
 * constants, plus the fiscal year's period count behind seasonal cycles.
 */
export interface HealthForecastParams {
  periodsPerYear: number;
  defaultMethod: string;
  methods: string[];
  defaultHorizon: number;
  defaultConfidence: number;
  defaultSeasonality: string;
  seasonalities: string[];
  horizons: number[];
  confidences: number[];
  adjustments: ForecastAdjustmentOption[];
  defaultAdjustment: string;
  /**
   * Declared future period names after the period end on non-monthly
   * calendars, capped at the longest offered horizon. Null on monthly cadence, where
   * the client labels calendar months in the viewer's locale. Empty when a
   * non-monthly calendar declares no future periods: the tab refuses by
   * name instead of labelling buckets it cannot reconcile.
   */
  futurePeriodNames: string[] | null;
  model: {
    alpha: number;
    beta: number;
    gamma: number;
    dampedPhi: number;
    ma1: number;
    minCorrelation: number;
    minPeriods: number;
  };
}

export interface HealthData extends FinancialHealth {
  monthly: MonthPoint[];
  pnlSummary: PnlLine[];
  marginFlow: MarginStage[];
  segments: { department: SegmentRow[]; class: SegmentRow[]; location: SegmentRow[] };
  drivers: { revenue: DriverRow[]; cost: DriverRow[] };
  items: { rows: ItemRow[]; gainers: ItemRow[]; decliners: ItemRow[]; totalCurrent: string; totalChange: string };
  insights: Insight[];
  budget: BudgetVariance;
  bands: HealthBands;
  forecast: HealthForecastParams;
}

type SqlNumeric = string | number | null;

interface HealthMonthSqlRow {
  month: string;
  func: string | null;
  late: string | null;
  revenue: SqlNumeric;
  operating_revenue: SqlNumeric;
  cogs: SqlNumeric;
  opex: SqlNumeric;
  other_exp: SqlNumeric;
}

interface HealthSegmentSqlRow {
  id: string;
  name: string;
  func: string | null;
  late_cur: string | null;
  late_prior: string | null;
  revenue: SqlNumeric;
  operating_revenue: SqlNumeric;
  cogs: SqlNumeric;
  opex: SqlNumeric;
  prior_revenue: SqlNumeric;
}

interface HealthDriverSqlRow {
  id: string;
  name: string;
  type: string;
  func: string | null;
  late_cur: string | null;
  late_prior: string | null;
  cur_raw: SqlNumeric;
  prior_raw: SqlNumeric;
}

interface HealthItemSqlRow {
  id: string;
  name: string;
  func: string | null;
  late_cur: string | null;
  late_prior: string | null;
  current: SqlNumeric;
  prior: SqlNumeric;
}


interface BudgetScenarioSqlRow {
  id: string;
  book_id: string;
  name: string;
  fiscal_year: SqlNumeric;
  status: string;
}

interface BudgetAccountSqlRow {
  id: string;
  name: string;
  type: string;
  budget: SqlNumeric;
  actual: SqlNumeric;
}

/**
 * Translate one leg amount, skipping the rate lookup for zero money: an
 * empty window's fallback date must never demand coverage for nothing.
 * Nonzero money without coverage still fails closed in rateAt.
 */
function translateAmount(
  amount: string,
  func: string | null,
  date: string,
  rateAt: (func: string | null, date: string) => string,
): string {
  return isZero(amount) ? "0" : mulDecimal(amount, rateAt(func, date));
}

/**
 * Dimensionless ratio of two exact amounts as a display/chart number.
 * The reports formula evaluator rounds to microunits from the exact decimal
 * inputs. A zero denominator yields 0 —
 * callers needing null-on-empty keep their own guard, as before.
 */
function amountRatio(numerator: string, denominator: string): number {
  const exact = evaluateAnalyticsRatio(numerator, denominator, "ratio", 6);
  if (exact === null) {
    if (isZero(denominator)) return 0;
    throw new Error("ANALYTICS_AMOUNT_RATIO_UNDEFINED");
  }
  return Number(exact);
}

/**
 * One-way projection of a canonical ledger string to a bounded display
 * number for the insights statistics below (trend slopes, σ anomalies).
 * Same contract as the client's `toChartNumber`, which this server module
 * cannot import (`_ui/format` is a client component): exact strings stay
 * the source of truth for every total, comparison, and decision, and only
 * dimensionless statistics consume the projection.
 */
function insightNumber(value: string): number {
  const exact = canonicalDecimal(value, 100);
  if (exact === null) throw new Error("insight values must be exact decimal strings");
  const limit = String(Number.MAX_SAFE_INTEGER);
  if (compareDecimal(exact, limit) > 0) return Number.MAX_SAFE_INTEGER;
  if (compareDecimal(exact, `-${limit}`) < 0) return -Number.MAX_SAFE_INTEGER;
  const n = Number(exact);
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, n));
}

/**
 * Trailing P&L series ending at the period end (fills gaps with zero).
 * Monthly-cadence organizations keep calendar months; any other declared
 * calendar prices its own trailing fiscal periods and labels them with the
 * period names, so a 4-4-5 or quarterly calendar never sees month-sliced
 * figures it cannot reconcile to its periods.
 */
async function monthlySeries(
  orgId: string,
  to: string,
  allowed: ReadonlySet<string> | null,
  months = 12,
  strings: HealthStrings = healthStrings(englishCatalogMessage, "en"),
): Promise<MonthPoint[]> {
  const declared = await defaultFiscalCalendarPeriods(orgId);
  if (declared && declared.cadence !== "monthly") {
    return fiscalPeriodSeries(orgId, to, allowed, months, declared.periods);
  }
  const end = new Date(to + "T00:00:00Z");
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999; month underflow normalizes the same way.
  const start = utcDateFromParts(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1);
  const startIso = start.toISOString().slice(0, 10);
  // A per-month P&L series is the exact shape gl_month_activity stores, so the
  // whole months read straight from it; only the final (possibly partial)
  // month falls back to the lines. The window always starts on a first-of-month.
  const r = ((await analyticsQuery(sql`
    with movement as (
      select g.account_id, to_char(g.month, 'YYYY-MM') as month,
             sub.base_currency as func,
             (g.debit_total - g.credit_total) as amt,
             (g.month + interval '1 month' - interval '1 day')::date::text as late
        from gl_month_activity g
        left join subsidiaries sub on sub.id = g.subsidiary_id and sub.org_id = g.org_id
       where g.org_id = ${orgId}
         and g.book_id = ${statementBookExpr(orgId)}
         ${subsidiaryVisibleFilter(sql`g.subsidiary_id`, allowed)}
         and g.month >= ${startIso}::date
         and g.month < date_trunc('month', ${to}::date)::date
      union all
      select l.account_id, to_char(e.posting_date, 'YYYY-MM'), sub.base_currency, l.amount,
             e.posting_date::text
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
         and e.book_id = ${statementBookExpr(orgId)}
         and e.posting_date >= date_trunc('month', ${to}::date)::date
         and e.posting_date <= ${to}
        left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
       where l.org_id = ${orgId}
         ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
    )
    select m.month, m.func, max(m.late) as late,
      -sum(case when a.type in ('income','income_other') then m.amt else 0 end) as revenue,
      -sum(case when a.type = 'income' then m.amt else 0 end) as operating_revenue,
      sum(case when a.type = 'cogs' then m.amt else 0 end) as cogs,
      sum(case when a.type in (${OPEX_TYPES_SQL}) then m.amt else 0 end) as opex,
      sum(case when a.type = 'expense_other' then m.amt else 0 end) as other_exp
    from movement m
    join accounts a on a.id = m.account_id and a.org_id = ${orgId}
    where a.type in (${PNL_TYPES_SQL})
    group by 1, 2
  `)));
  const monthRows = r.rows as unknown as HealthMonthSqlRow[];
  // One shared flow context over every (month, functional) leg; each type
  // bucket translates at its leg's latest date, then merges per month.
  const monthCtx = await flowRates(orgId, monthRows.map((x) => ({
    func: x.func ?? null, date: String(x.late ?? to).slice(0, 10),
  })));
  const rateAt = (func: string | null, date: string) => monthCtx.rateAt(func, date);
  const by = new Map<string, HealthMonthSqlRow>();
  for (const x of monthRows) {
    const prior = by.get(x.month);
    const date = String(x.late ?? to).slice(0, 10);
    const t = (v: SqlNumeric) => translateAmount(String(v ?? 0), x.func ?? null, date, rateAt);
    const merged: HealthMonthSqlRow = prior
      ? {
          ...prior,
          revenue: add(String(prior.revenue ?? 0), t(x.revenue)),
          operating_revenue: add(String(prior.operating_revenue ?? 0), t(x.operating_revenue)),
          cogs: add(String(prior.cogs ?? 0), t(x.cogs)),
          opex: add(String(prior.opex ?? 0), t(x.opex)),
          other_exp: add(String(prior.other_exp ?? 0), t(x.other_exp)),
        }
      : {
          ...x,
          revenue: t(x.revenue),
          operating_revenue: t(x.operating_revenue),
          cogs: t(x.cogs),
          opex: t(x.opex),
          other_exp: t(x.other_exp),
        };
    by.set(x.month, merged);
  }
  const out: MonthPoint[] = [];
  for (let i = 0; i < months; i++) {
    const dt = utcDateFromParts(start.getUTCFullYear(), start.getUTCMonth() + i, 1);
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    const row = by.get(ym);
    const revenue = String(row?.revenue ?? 0);
    const cogs = String(row?.cogs ?? 0);
    const opex = String(row?.opex ?? 0);
    const operatingRevenue = String(row?.operating_revenue ?? 0);
    const otherExp = String(row?.other_exp ?? 0);
    const grossProfit = sum([revenue, neg(cogs)]);
    const operatingIncome = sum([operatingRevenue, neg(cogs), neg(opex)]);
    const netIncome = sum([revenue, neg(cogs), neg(opex), neg(otherExp)]);
    const revPositive = cmp(revenue, "0") > 0;
    out.push({
      month: ym,
      label: strings.monthLabel(ym),
      revenue,
      cogs,
      grossProfit,
      grossMarginPct: revPositive ? amountRatio(grossProfit, revenue) : null,
      opex,
      operatingIncome,
      operatingMarginPct: revPositive ? amountRatio(operatingIncome, revenue) : null,
      netIncome,
    });
  }
  return out;
}

/**
 * The same trailing series over declared fiscal periods instead of calendar
 * months. Period boundaries come from the organization's own calendar, so a
 * weekly or quarterly calendar prices whole periods it can reconcile. Each
 * point keys on the period's start date and labels with the period name.
 * Periods do not align with months, so the series reads the journal lines
 * directly — the monthly gl_month_activity rollup cannot bucket them.
 */
async function fiscalPeriodSeries(
  orgId: string,
  to: string,
  allowed: ReadonlySet<string> | null,
  months: number,
  periods: FiscalPeriod[],
): Promise<MonthPoint[]> {
  // The trailing periods at or before the period end, the last possibly
  // partial. Older activity stays outside the window, as with months.
  const trailing = periods.filter((p) => p.from <= to).slice(-months);
  if (trailing.length === 0) return [];
  // A mid-period or historical end sits inside the last period: the bucket
  // closes at the selected end, never at the period's far edge, so postings
  // after the end cannot leak into the trailing figures. ISO dates compare
  // lexicographically, so the clamp is a plain string minimum.
  const endOf = (p: FiscalPeriod) => (p.to <= to ? p.to : to);
  const bucket = (i: number) => `period_${i}`;
  const whens = trailing.map((p, i) => sql`when l.posting_date >= ${p.from}::date and l.posting_date <= ${endOf(p)}::date then ${bucket(i)}`);
  const ranges = trailing.map((p) => sql`(l.posting_date >= ${p.from}::date and l.posting_date <= ${endOf(p)}::date)`);
  const r = ((await analyticsQuery(sql`
    select (case ${sql.join(whens, sql` `)} end) as month,
      sub.base_currency as func,
      max(l.posting_date)::text as late,
      -sum(case when a.type in ('income','income_other') then l.amount else 0 end) as revenue,
      -sum(case when a.type = 'income' then l.amount else 0 end) as operating_revenue,
      sum(case when a.type = 'cogs' then l.amount else 0 end) as cogs,
      sum(case when a.type in (${OPEX_TYPES_SQL}) then l.amount else 0 end) as opex,
      sum(case when a.type = 'expense_other' then l.amount else 0 end) as other_exp
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    where l.org_id = ${orgId}
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      and a.type in (${PNL_TYPES_SQL})
      and (${sql.join(ranges, sql` or `)})
    group by 1, 2
  `)));
  const rows = r.rows as unknown as (HealthMonthSqlRow & { month: string })[];
  const ctx = await flowRates(orgId, rows.map((x) => ({
    func: x.func ?? null, date: String(x.late ?? to).slice(0, 10),
  })));
  const rateAt = (func: string | null, date: string) => ctx.rateAt(func, date);
  const by = new Map<string, HealthMonthSqlRow>();
  for (const x of rows) {
    const prior = by.get(x.month);
    const date = String(x.late ?? to).slice(0, 10);
    const t = (v: SqlNumeric) => translateAmount(String(v ?? 0), x.func ?? null, date, rateAt);
    by.set(x.month, prior
      ? {
        ...prior,
        revenue: add(String(prior.revenue ?? 0), t(x.revenue)),
        operating_revenue: add(String(prior.operating_revenue ?? 0), t(x.operating_revenue)),
        cogs: add(String(prior.cogs ?? 0), t(x.cogs)),
        opex: add(String(prior.opex ?? 0), t(x.opex)),
        other_exp: add(String(prior.other_exp ?? 0), t(x.other_exp)),
      }
      : { ...x, revenue: t(x.revenue), operating_revenue: t(x.operating_revenue), cogs: t(x.cogs), opex: t(x.opex), other_exp: t(x.other_exp) });
  }
  return trailing.map((p, i) => {
    const row = by.get(bucket(i));
    const revenue = String(row?.revenue ?? 0);
    const cogs = String(row?.cogs ?? 0);
    const opex = String(row?.opex ?? 0);
    const operatingRevenue = String(row?.operating_revenue ?? 0);
    const otherExp = String(row?.other_exp ?? 0);
    const grossProfit = sum([revenue, neg(cogs)]);
    const operatingIncome = sum([operatingRevenue, neg(cogs), neg(opex)]);
    const netIncome = sum([revenue, neg(cogs), neg(opex), neg(otherExp)]);
    const revPositive = cmp(revenue, "0") > 0;
    return {
      month: p.from,
      label: p.name,
      revenue,
      cogs,
      grossProfit,
      grossMarginPct: revPositive ? amountRatio(grossProfit, revenue) : null,
      opex,
      operatingIncome,
      operatingMarginPct: revPositive ? amountRatio(operatingIncome, revenue) : null,
      netIncome,
    };
  });
}

/** Operating-margin target and warning share behind the segment health dot, exact fractions. */
export interface SegmentHealthPolicy {
  target: string;
  warningShare: string;
}

/**
 * Grade one segment's operating margin against the organization's own
 * target: at or above target is good, within the configured warning share
 * of target is warn, below that is bad. Without revenue there is no margin
 * to grade, so the segment carries no health — never a stand-in dot.
 * Exported for unit tests.
 */
export function gradeSegmentHealth(opMargin: string | null, policy: SegmentHealthPolicy): SegmentRow["health"] {
  if (opMargin === null) return null;
  if (cmp(opMargin, policy.target) >= 0) return "good";
  if (cmp(opMargin, mulDecimal(policy.target, policy.warningShare)) >= 0) return "warn";
  return "bad";
}

/** Segment breakdown for one dimension (department/class/location) with YoY. */
async function segmentsBy(
  orgId: string,
  dimCol: "department_id" | "class_id" | "location_id",
  dimTable: "departments" | "classes" | "locations",
  from: string,
  to: string,
  allowed: ReadonlySet<string> | null,
  healthPolicy: SegmentHealthPolicy,
  strings: HealthStrings = healthStrings(englishCatalogMessage, "en"),
): Promise<SegmentRow[]> {
  // The comparison window is the same window one fiscal year earlier on
  // the organization's own calendar, never calendar −12 months.
  const { from: pFrom, to: pTo } = await priorFiscalWindow(orgId, from, to);
  const col = sql.raw(`l.${dimCol}`);
  const tbl = sql.raw(dimTable);
  // LEFT JOIN so untagged GL activity lands in an "Unassigned" bucket (the
  // parity) — segment totals then tie out to the P&L instead of silently
  // dropping lines with no dimension.
  // Keep the date predicate on the line for selectivity; the entry controls
  // posted status and the primary accounting book, just as the headline does.
  const r = ((await analyticsQuery(sql`
    select coalesce(d.id::text, 'unassigned') as id, coalesce(d.name, 'Unassigned') as name,
      sub.base_currency as func,
      max(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.posting_date end)::text as late_cur,
      max(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.posting_date end)::text as late_prior,
      -sum(case when a.type in ('income','income_other') and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as revenue,
      -sum(case when a.type = 'income' and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as operating_revenue,
      sum(case when a.type = 'cogs' and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as cogs,
      sum(case when a.type in (${OPEX_TYPES_SQL}) and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as opex,
      -sum(case when a.type in ('income','income_other') and l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.amount else 0 end) as prior_revenue
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    left join ${tbl} d on d.id = ${col} and d.org_id = l.org_id
    where l.org_id = ${orgId}
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      and a.type in (${PNL_TYPES_SQL})
      and l.posting_date >= ${pFrom} and l.posting_date <= ${to}
    group by 1, 2, 3
    having abs(-sum(case when a.type in ('income','income_other') and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end)) > 0
        or abs(sum(case when a.type in (${PNL_COST_TYPES_SQL}) and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end)) > 0
  `)));
  const segLegs = r.rows as unknown as HealthSegmentSqlRow[];
  // Current-window legs translate at their latest current date, prior legs
  // at their latest prior date, then merge per segment in presentation.
  const segCtx = await flowRates(orgId, [
    ...segLegs.map((x) => ({ func: x.func ?? null, date: String(x.late_cur ?? to).slice(0, 10) })),
    ...segLegs.map((x) => ({ func: x.func ?? null, date: String(x.late_prior ?? pTo).slice(0, 10) })),
  ]);
  const segById = new Map<string, {
    id: string; name: string; revenue: string; operating_revenue: string;
    cogs: string; opex: string; prior_revenue: string;
  }>();
  const segRateAt = (func: string | null, date: string) => segCtx.rateAt(func, date);
  for (const x of segLegs) {
    const cur = (v: SqlNumeric) =>
      translateAmount(String(v ?? 0), x.func ?? null, String(x.late_cur ?? to).slice(0, 10), segRateAt);
    const prior = (v: SqlNumeric) =>
      translateAmount(String(v ?? 0), x.func ?? null, String(x.late_prior ?? pTo).slice(0, 10), segRateAt);
    const prev = segById.get(x.id);
    const merged = {
      id: x.id,
      name: x.name,
      revenue: add(String(prev?.revenue ?? 0), cur(x.revenue)),
      operating_revenue: add(String(prev?.operating_revenue ?? 0), cur(x.operating_revenue)),
      cogs: add(String(prev?.cogs ?? 0), cur(x.cogs)),
      opex: add(String(prev?.opex ?? 0), cur(x.opex)),
      prior_revenue: add(String(prev?.prior_revenue ?? 0), prior(x.prior_revenue)),
    };
    segById.set(x.id, merged);
  }
  const rows = [...segById.values()];
  // A dimension nobody tags is unused, not "one big Unassigned segment" — keep
  // the empty state in that case.
  if (rows.every((x) => x.id === "unassigned")) return [];
  const totalRev = sum(rows.map((x) => String(x.revenue ?? 0)));
  return rows
    .map((x): SegmentRow => {
      const revenue = String(x.revenue ?? 0);
      const priorRev = String(x.prior_revenue ?? 0);
      const cogs = String(x.cogs ?? 0);
      const opex = String(x.opex ?? 0);
      const operatingRevenue = String(x.operating_revenue ?? 0);
      const grossProfit = sum([revenue, neg(cogs)]);
      const operatingIncome = sum([operatingRevenue, neg(cogs), neg(opex)]);
      const revPositive = cmp(revenue, "0") > 0;
      const gmPct = revPositive ? amountRatio(grossProfit, revenue) : null;
      const opPct = revPositive ? amountRatio(operatingIncome, revenue) : null;
      const yoyPct = cmp(priorRev, "0") > 0 ? amountRatio(sum([revenue, neg(priorRev)]), priorRev) : null;
      const opMargin = revPositive ? decimalRatio(operatingIncome, revenue) : null;
      const health = gradeSegmentHealth(opMargin, healthPolicy);
      return {
        id: x.id,
        name: strings.displaySegmentName(x.id, x.name),
        revenue,
        sharePct: amountRatio(revenue, totalRev),
        grossProfit,
        grossMarginPct: gmPct,
        operatingIncome,
        operatingMarginPct: opPct,
        yoyPct,
        health,
      };
    })
    .sort((a, b) => cmp(b.revenue, a.revenue));
}

/** Top account-level movers vs prior year, split into revenue and cost. */
async function drivers(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null): Promise<{ revenue: DriverRow[]; cost: DriverRow[] }> {
  // The comparison window is the same window one fiscal year earlier on
  // the organization's own calendar, never calendar −12 months.
  const { from: pFrom, to: pTo } = await priorFiscalWindow(orgId, from, to);
  // Retain the selective line-date predicate while enforcing ledger status/book.
  const r = ((await analyticsQuery(sql`
    select a.id, a.name, a.type, sub.base_currency as func,
      max(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.posting_date end)::text as late_cur,
      max(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.posting_date end)::text as late_prior,
      sum(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as cur_raw,
      sum(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.amount else 0 end) as prior_raw
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    where l.org_id = ${orgId}
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      and a.type in (${PNL_TYPES_SQL})
      and l.posting_date >= ${pFrom} and l.posting_date <= ${to}
    group by a.id, a.name, a.type, sub.base_currency
  `)));
  const drvLegs = r.rows as unknown as HealthDriverSqlRow[];
  const drvCtx = await flowRates(orgId, [
    ...drvLegs.map((x) => ({ func: x.func ?? null, date: String(x.late_cur ?? to).slice(0, 10) })),
    ...drvLegs.map((x) => ({ func: x.func ?? null, date: String(x.late_prior ?? pTo).slice(0, 10) })),
  ]);
  const drvByAccount = new Map<string, { name: string; type: string; current: string; prior: string }>();
  const drvRateAt = (func: string | null, date: string) => drvCtx.rateAt(func, date);
  for (const x of drvLegs) {
    const prev = drvByAccount.get(x.id) ?? { name: x.name, type: x.type, current: "0", prior: "0" };
    prev.current = add(
      prev.current,
      translateAmount(String(x.cur_raw ?? 0), x.func ?? null, String(x.late_cur ?? to).slice(0, 10), drvRateAt),
    );
    prev.prior = add(
      prev.prior,
      translateAmount(String(x.prior_raw ?? 0), x.func ?? null, String(x.late_prior ?? pTo).slice(0, 10), drvRateAt),
    );
    drvByAccount.set(x.id, prev);
  }
  const isIncome = (t: string) => t === "income" || t === "income_other";
  const rows = [...drvByAccount.entries()].map(([id, v]) => {
    const flip = isIncome(v.type);
    const current = flip ? neg(v.current) : v.current;
    const prior = flip ? neg(v.prior) : v.prior;
    const change = sum([current, neg(prior)]);
    return {
      id,
      name: v.name,
      type: v.type,
      current,
      prior,
      change,
      changePct: cmp(prior, "0") !== 0 ? amountRatio(change, abs(prior)) : null,
      isIncome: isIncome(v.type),
    };
  });
  const rank = (subset: typeof rows) => {
    const totalMove = sum(subset.map((x) => abs(x.change)));
    return subset
      .map((x): DriverRow => ({ ...x, contribution: amountRatio(abs(x.change), totalMove) }))
      .sort((a, b) => cmp(abs(b.change), abs(a.change)))
      .slice(0, 12);
  };
  return {
    revenue: rank(rows.filter((x) => x.isIncome)),
    cost: rank(rows.filter((x) => !x.isIncome)),
  };
}

/**
 * Item-level revenue analysis. Catalog items aren't tagged on this ledger's
 * invoice lines, so the GL-native equivalent is revenue by income/service
 * account — each revenue account is the "line item". Current vs prior year.
 */
async function itemAnalysis(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null): Promise<HealthData["items"]> {
  // The comparison window is the same window one fiscal year earlier on
  // the organization's own calendar, never calendar −12 months.
  const { from: pFrom, to: pTo } = await priorFiscalWindow(orgId, from, to);
  const r = ((await analyticsQuery(sql`
    select a.id, a.name, sub.base_currency as func,
      max(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.posting_date end)::text as late_cur,
      max(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.posting_date end)::text as late_prior,
      -sum(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as current,
      -sum(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.amount else 0 end) as prior
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    where l.org_id = ${orgId}
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      and a.type in ('income','income_other')
      and l.posting_date >= ${pFrom} and l.posting_date <= ${to}
    group by a.id, a.name, sub.base_currency
  `)));
  const itemLegs = r.rows as unknown as HealthItemSqlRow[];
  const itemCtx = await flowRates(orgId, [
    ...itemLegs.map((x) => ({ func: x.func ?? null, date: String(x.late_cur ?? to).slice(0, 10) })),
    ...itemLegs.map((x) => ({ func: x.func ?? null, date: String(x.late_prior ?? pTo).slice(0, 10) })),
  ]);
  const itemByAccount = new Map<string, { name: string; current: string; prior: string }>();
  const itemRateAt = (func: string | null, date: string) => itemCtx.rateAt(func, date);
  for (const x of itemLegs) {
    const prev = itemByAccount.get(x.id) ?? { name: x.name, current: "0", prior: "0" };
    prev.current = add(
      prev.current,
      translateAmount(String(x.current ?? 0), x.func ?? null, String(x.late_cur ?? to).slice(0, 10), itemRateAt),
    );
    prev.prior = add(
      prev.prior,
      translateAmount(String(x.prior ?? 0), x.func ?? null, String(x.late_prior ?? pTo).slice(0, 10), itemRateAt),
    );
    itemByAccount.set(x.id, prev);
  }
  const totalChangeAbs = sum(
    [...itemByAccount.values()].map((x) => abs(sum([x.current, neg(x.prior)]))),
  );
  const rows = ([...itemByAccount.entries()])
    .map(([id, v]): ItemRow => {
      const current = v.current;
      const prior = v.prior;
      const change = sum([current, neg(prior)]);
      return {
        id,
        name: v.name,
        prior,
        current,
        change,
        changePct: cmp(prior, "0") !== 0 ? amountRatio(change, abs(prior)) : null,
        contribution: amountRatio(abs(change), totalChangeAbs),
      };
    })
    .filter((x) => cmp(x.current, "0") !== 0 || cmp(x.prior, "0") !== 0)
    .sort((a, b) => cmp(b.current, a.current));
  const gainers = [...rows].filter((x) => cmp(x.change, "0") > 0).sort((a, b) => cmp(b.change, a.change)).slice(0, 5);
  const decliners = [...rows].filter((x) => cmp(x.change, "0") < 0).sort((a, b) => cmp(a.change, b.change)).slice(0, 5);
  return {
    rows,
    gainers,
    decliners,
    totalCurrent: sum(rows.map((x) => x.current)),
    totalChange: sum(rows.map((x) => x.change)),
  };
}

function buildPnlSummary(
  f: HealthPnlFigures,
  prior: HealthPnlFigures,
  strings: HealthStrings = healthStrings(englishCatalogMessage, "en"),
): PnlLine[] {
  const line = (key: Parameters<HealthStrings["pnlLine"]>[0], current: string, priorV: string, strong?: boolean): PnlLine => ({
    key,
    label: strings.pnlLine(key),
    current,
    prior: priorV,
    change: add(current, neg(priorV)),
    changePct: isZero(priorV) ? null : decimalRatio(add(current, neg(priorV)), abs(priorV)),
    strong,
  });
  return [
    line("revenue", f.revenue, prior.revenue, true),
    line("cogs", f.cogs, prior.cogs),
    line("grossProfit", f.grossProfit, prior.grossProfit, true),
    line("opex", f.opex, prior.opex),
    line("operatingIncome", f.operatingIncome, prior.operatingIncome, true),
    line("otherExpense", f.otherExpense, prior.otherExpense),
    line("netIncome", f.netIncome, prior.netIncome, true),
  ];
}

function buildMarginFlow(f: HealthFigures, strings: HealthStrings = healthStrings(englishCatalogMessage, "en")): MarginStage[] {
  // With no revenue a share of revenue does not exist — never divide by a stand-in.
  const share = (n: string): string | null => (cmp(f.revenue, "0") > 0 ? decimalRatio(n, f.revenue) : null);
  const stage = (key: Parameters<HealthStrings["marginStage"]>[0], amount: string, kind: MarginStage["kind"]): MarginStage =>
    ({ key, label: strings.marginStage(key), amount, pctOfRevenue: share(amount), kind });
  // Operating income here is the engine's: income tax booked to an operating
  // account is excluded, so the tax line sits with the non-operating items.
  const reconcilingTax = add(f.netIncome, neg(add(add(f.operatingIncome, f.otherIncome), neg(f.otherExpense))));
  return [
    stage("revenue", f.revenue, "start"),
    stage("cogs", neg(f.cogs), "deduct"),
    stage("grossProfit", f.grossProfit, "subtotal"),
    stage("opex", neg(f.opex), "deduct"),
    // Revenue and gross profit include other income, but operating income
    // excludes it. Show both adjustments so each subtotal reconciles.
    stage("excludeOtherIncome", neg(f.otherIncome), "deduct"),
    stage("operatingIncome", f.operatingIncome, "subtotal"),
    stage("otherIncome", f.otherIncome, "deduct"),
    stage("otherExpense", add(neg(f.otherExpense), reconcilingTax), "deduct"),
    stage("netIncome", f.netIncome, "total"),
  ];
}

/** Thresholds behind the findings — organization configuration, not constants. */
interface InsightPolicy {
  /** Fractions of the target below which a margin is critical / well below. */
  critical: string;
  warning: string;
  revenueDecline: string;
  revenueTrend: string;
  marginCompression: number;
  breakevenSafety: string;
  anomalySigma: number;
}

async function insightPolicy(orgId: string): Promise<InsightPolicy> {
  const c = await analyticsConfig(orgId, "financialHealth");
  const fraction = (pct: number) => decimalRatio(String(pct), "100")!;
  return {
    critical: fraction(c.insightCriticalPercent),
    warning: fraction(c.insightWarningPercent),
    revenueDecline: fraction(c.revenueDeclineAlertPercent),
    revenueTrend: fraction(c.revenueTrendAlertPercent),
    marginCompression: c.marginCompressionPoints / 100,
    breakevenSafety: fraction(c.breakevenSafetyPercent),
    anomalySigma: c.anomalySigma,
  };
}

/** Derive Issues / Recommendations / Anomalies from the graded ratios and the trend. */
function buildInsights(
  base: FinancialHealth,
  monthly: MonthPoint[],
  policy: InsightPolicy,
  money: (value: string) => string,
  strings: HealthStrings = healthStrings(englishCatalogMessage, "en"),
): Insight[] {
  const out: Insight[] = [];
  const f = base.figures;
  const T = base.benchmarks.targets;
  const ratio = (id: string) => Object.values(base.ratios).flat().find((r) => r.id === id)?.value ?? null;
  // Percentage points rendered in the request locale for the finding sentences.
  const points = (fraction: string) =>
    new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 1 }).format(mulDecimal(fraction, "100") as unknown as number);
  const below = (value: string, target: string, share: string) => cmp(value, mulDecimal(target, share)) < 0;

  const gm = ratio("gross_margin");
  const opm = ratio("operating_margin");
  if (cmp(f.operatingIncome, "0") < 0) out.push(strings.operatingLoss(money(f.operatingIncome)));
  if (gm !== null && T.gross_margin !== null) {
    if (below(gm, T.gross_margin, policy.critical)) out.push(strings.gmCritical(points(gm), points(T.gross_margin)));
    else if (below(gm, T.gross_margin, policy.warning)) out.push(strings.gmWellBelow(points(gm), points(T.gross_margin)));
    else if (cmp(gm, T.gross_margin) < 0) out.push(strings.gmBelow(points(gm), points(T.gross_margin)));
  }
  if (opm !== null && T.operating_margin !== null && cmp(opm, "0") >= 0) {
    if (below(opm, T.operating_margin, policy.critical)) out.push(strings.opmCritical(points(opm), points(T.operating_margin)));
    else if (cmp(opm, T.operating_margin) < 0) out.push(strings.opmBelow(points(opm), points(T.operating_margin)));
  }
  if (cmp(f.netIncome, "0") < 0) out.push(strings.netLoss(money(f.netIncome)));
  if (f.revenueGrowth !== null) {
    if (cmp(f.revenueGrowth, neg(policy.revenueDecline)) < 0) out.push(strings.revFalling(points(abs(f.revenueGrowth))));
    else if (cmp(f.revenueGrowth, "0") < 0) out.push(strings.revDeclined(points(abs(f.revenueGrowth))));
  }
  // Trend rules over the trailing three periods: revenue slope and margin
  // compression. On non-monthly calendars the series holds fiscal periods,
  // never calendar months — the rule counts periods either way.
  const recent = monthly
    .filter((m): m is MonthPoint & { grossMarginPct: number } => cmp(m.revenue, "0") > 0 && m.grossMarginPct !== null)
    .slice(-3);
  if (recent.length === 3) {
    const [a, b, c] = recent;
    const floor = mulDecimal(a!.revenue, add("1", neg(policy.revenueTrend)));
    if (cmp(c!.revenue, floor) < 0) {
      out.push(strings.revTrendingDown(points(decimalRatio(add(a!.revenue, neg(c!.revenue)), abs(a!.revenue))!)));
    }
    if (a!.grossMarginPct - c!.grossMarginPct > policy.marginCompression && b!.grossMarginPct <= a!.grossMarginPct)
      out.push(strings.marginCompression(points(String((a!.grossMarginPct - c!.grossMarginPct).toFixed(4)))));
  }
  // Safety margin: how far the period's revenue sits above its breakeven.
  if (f.breakevenRevenue !== null && cmp(f.revenue, "0") > 0) {
    const safety = decimalRatio(add(f.revenue, neg(f.breakevenRevenue)), f.revenue)!;
    if (cmp(safety, "0") < 0) out.push(strings.belowBreakeven(money(f.breakevenRevenue)));
    else if (cmp(safety, policy.breakevenSafety) < 0) out.push(strings.thinMargin(points(safety)));
  }
  const opexShare = ratio("opex_ratio");
  if (opexShare !== null && T.opex_ratio !== null && cmp(opexShare, T.opex_ratio) > 0)
    out.push(strings.heavyOverhead(points(opexShare)));

  if (gm !== null && T.gross_margin !== null && cmp(gm, T.gross_margin) >= 0) out.push(strings.healthyGM);
  if (gm !== null && opm !== null && T.gross_margin !== null && T.operating_margin !== null
    && cmp(opm, T.operating_margin) < 0 && !below(gm, T.gross_margin, policy.warning)) out.push(strings.trimOpex);
  if (f.operatingLeverage !== null && T.operating_leverage !== null && cmp(f.operatingLeverage, T.operating_leverage) >= 0)
    out.push(strings.posLeverage(new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 1 }).format(f.operatingLeverage as unknown as number)));
  if (f.rule40 !== null && T.rule_of_40 !== null && cmp(f.rule40, T.rule_of_40) >= 0)
    out.push(strings.rule40(new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 0 }).format(f.rule40 as unknown as number)));

  // Anomalies: periods deviating beyond the configured number of standard
  // deviations. Dimensionless statistics read the bounded display projection.
  const withRev = monthly.filter(
    (m): m is MonthPoint & { grossMarginPct: number } => cmp(m.revenue, "0") > 0 && m.grossMarginPct !== null,
  );
  if (withRev.length >= 4) {
    const margins = withRev.map((m) => m.grossMarginPct);
    const mean = margins.reduce((a, x) => a + x, 0) / margins.length;
    const sd = Math.sqrt(margins.reduce((a, x) => a + (x - mean) ** 2, 0) / margins.length);
    for (const m of withRev) {
      if (sd > 0 && Math.abs(m.grossMarginPct - mean) > policy.anomalySigma * sd) {
        out.push(strings.marginOutlier(m.label, points(m.grossMarginPct.toFixed(4)), points(mean.toFixed(4))));
      }
    }
    const revs = withRev.map((m) => insightNumber(m.revenue));
    const rMean = revs.reduce((a, x) => a + x, 0) / revs.length;
    const rSd = Math.sqrt(revs.reduce((a, x) => a + (x - rMean) ** 2, 0) / revs.length);
    const meanRevenue = decimalRatio(sum(withRev.map((m) => m.revenue)), String(withRev.length))!;
    for (const m of withRev) {
      if (rSd > 0 && Math.abs(insightNumber(m.revenue) - rMean) > policy.anomalySigma * rSd) {
        out.push(strings.revenueSpike(m.label, money(m.revenue), money(meanRevenue)));
      }
    }
  }
  return out;
}

/** The landing card and the home-dashboard widgets read the authoritative
 * scorecard, the monthly summary and the findings, without loading
 * comparison tables, dimensional analyses or budget detail. */
export async function healthSummaryData(
  period: { from: string; to: string; label: string },
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  strings: HealthStrings = healthStrings(englishCatalogMessage, "en"),
): Promise<FinancialHealth & { monthly: MonthPoint[]; insights: Insight[] }> {
  const { money: formatMoney } = await getMoneyFormatter(orgId);
  const money = (value: string) => formatMoney(value, { maximumFractionDigits: 0 });
  const [base, monthly, policy] = await Promise.all([
    financialHealth(period, orgId, allowedSubsidiaryIds, strings),
    monthlySeries(orgId, period.to, allowedSubsidiaryIds, 12, strings),
    insightPolicy(orgId),
  ]);
  return { ...base, monthly, insights: buildInsights(base, monthly, policy, money, strings) };
}

export async function healthData(
  period: { from: string; to: string; label: string },
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  strings: HealthStrings = healthStrings(englishCatalogMessage, "en"),
): Promise<HealthData> {
  const { money: formatMoney } = await getMoneyFormatter(orgId)
  const money = (value: string) => formatMoney(value, { maximumFractionDigits: 0 })
  const { from, to } = period;

  const budgetsOn = await isFeatureEnabled(orgId, "budgets");
  // One healthBands read serves the segment health dots, the client-side
  // bands and — threaded through — the budget tolerance below, so no tab
  // keeps its own copy. The forecast parameters and the insight policy read
  // their own slices beside it.
  const configured = await healthBands(orgId);
  const emptyBudget = (tolerance: BudgetTolerance): BudgetVariance =>
    ({ scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance });

  const [base, monthly, forecast, dept, cls, loc, drv, items, budget, policy] = await Promise.all([
    financialHealth(period, orgId, allowedSubsidiaryIds, strings),
    monthlySeries(orgId, to, allowedSubsidiaryIds, 12, strings),
    forecastParams(orgId, to),
    analyticsSection('financial-health', ['segments']) ? segmentsBy(orgId, "department_id", "departments", from, to, allowedSubsidiaryIds, configured.segment, strings) : Promise.resolve([]),
    analyticsSection('financial-health', ['segments']) ? segmentsBy(orgId, "class_id", "classes", from, to, allowedSubsidiaryIds, configured.segment, strings) : Promise.resolve([]),
    analyticsSection('financial-health', ['segments']) ? segmentsBy(orgId, "location_id", "locations", from, to, allowedSubsidiaryIds, configured.segment, strings) : Promise.resolve([]),
    analyticsSection('financial-health', ['drivers']) ? drivers(orgId, from, to, allowedSubsidiaryIds) : Promise.resolve({ revenue: [], cost: [] }),
    analyticsSection('financial-health', ['items']) ? itemAnalysis(orgId, from, to, allowedSubsidiaryIds) : Promise.resolve({ rows: [], gainers: [], decliners: [], totalCurrent: '0', totalChange: '0' }),
    budgetsOn && analyticsSection('financial-health', ['budget'])
      ? budgetVariance(orgId, from, to, allowedSubsidiaryIds, configured.tolerance)
      : Promise.resolve(emptyBudget(configured.tolerance)),
    insightPolicy(orgId),
  ]);

  return {
    ...base,
    monthly,
    pnlSummary: analyticsSection('financial-health', ['overview', 'margin']) ? buildPnlSummary(base.figures, base.priorFigures, strings) : [],
    marginFlow: buildMarginFlow(base.figures, strings),
    segments: { department: dept, class: cls, location: loc },
    drivers: drv,
    items,
    budget,
    bands: configured.bands,
    forecast,
    insights: buildInsights(base, monthly, policy, money, strings),
  };
}

/**
 * Budget-line status rule: on-track when favorable or within the configured
 * tolerance, watch to the configured watch band, and beyond that the
 * direction keeps its meaning — overspent cost lines read "over", missed
 * revenue lines read "under". Flagging a revenue shortfall as over-budget
 * spend inverts the story, so income and cost have distinct
 * unfavorable-beyond-tolerance statuses while sharing the neutral watch
 * band. The tolerance comes from the caller (the organization's configured
 * bands) — the rule keeps no starting percentages of its own. Band edges
 * cross-multiply exactly (|variance|*100 against tolerance*|budget|) with
 * no intermediate ratio: decimalRatio rounds to 4dp first, so 7004/100000
 * read 0.0700 and graded on-track against a 7% band it truly exceeds.
 * Exported for unit tests.
 */
export function budgetLineStatus(
  type: string,
  variance: string,
  budget: string,
  tolerance: BudgetTolerance,
): BudgetRow["status"] {
  const favorable = type === "income" || type === "income_other" ? cmp(variance, "0") >= 0 : cmp(variance, "0") <= 0;
  if (isZero(budget)) return "no-budget";
  if (favorable) return "on-track";
  const scaled = mulDecimal(abs(variance), "100");
  const base = abs(budget);
  if (cmp(scaled, mulDecimal(String(tolerance.onTrack), base)) <= 0) return "on-track";
  if (cmp(scaled, mulDecimal(String(tolerance.watch), base)) <= 0) return "watch";
  return type === "income" || type === "income_other" ? "under" : "over";
}

/** Declared periods per fiscal year on the organization's calendar: twelve for a monthly cadence by definition. */
async function fiscalPeriodsPerYear(orgId: string, asOf: string): Promise<number> {
  const declared = await defaultFiscalCalendarPeriods(orgId);
  if (!declared || declared.cadence === "monthly" || declared.periods.length === 0) return 12;
  const containing = declared.periods.find((p) => p.from <= asOf && asOf <= p.to);
  const year = containing?.fiscalYear ?? Math.max(...declared.periods.map((p) => p.fiscalYear));
  const count = declared.periods.filter((p) => p.fiscalYear === year).length;
  // The year always comes from a declared period, so zero is unreachable —
  // but falling back to 12 would silently price a non-monthly calendar as
  // monthly. Refuse by name instead.
  if (count === 0) throw new Error(`fiscal calendar declares no periods for fiscal year ${year} — declare the year's periods in the fiscal calendar`);
  return count;
}

/**
 * Macro-adjustment factor behind a forecast adjustment code, read from the
 * single FORECAST_ADJUSTMENTS table in config-spec — the same table the
 * threshold editor's select options are derived from, so an offered option
 * always prices and a code outside the table fails loudly by name rather
 * than pricing a band the organization never asked for. Exported for tests.
 */
export function forecastAdjustmentValue(code: string): number {
  const row = FORECAST_ADJUSTMENTS.find((a) => a.code === code);
  if (!row) {
    const known = FORECAST_ADJUSTMENTS.map((a) => a.code).join(", ");
    throw new Error(`unknown forecast adjustment code "${code}" — known codes: ${known}`);
  }
  return row.factor;
}

/**
 * Declared future period names after `asOf` on the organization's own
 * calendar, capped at `need`. Null when the calendar is monthly or
 * undeclared (the client labels calendar months); an empty array when a
 * non-monthly calendar declares no future periods, which the tab refuses
 * by name instead of labelling buckets it cannot reconcile.
 */
async function upcomingFiscalPeriodNames(orgId: string, asOf: string, need: number): Promise<string[] | null> {
  const declared = await defaultFiscalCalendarPeriods(orgId);
  if (!declared || declared.cadence === "monthly" || declared.periods.length === 0) return null;
  return declared.periods
    .filter((p) => p.from > asOf)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .slice(0, need)
    .map((p) => p.name);
}

/** The forecast model as configured, with offered choices from the threshold spec. */
async function forecastParams(orgId: string, asOf: string): Promise<HealthForecastParams> {
  const [c, periodsPerYear] = await Promise.all([
    analyticsConfig(orgId, "financialHealth"),
    fiscalPeriodsPerYear(orgId, asOf),
  ]);
  const fields = new Map(analyticsConfigSpec("financialHealth").fields.map((f) => [f.key, f]));
  const codes = (key: string): string[] => [...(fields.get(key)?.options ?? [])];
  const horizons = codes("forecastHorizon").map(Number);
  return {
    periodsPerYear,
    defaultMethod: String(c.forecastMethod),
    methods: codes("forecastMethod"),
    defaultHorizon: Number(c.forecastHorizon),
    defaultConfidence: Number(c.forecastConfidence),
    defaultSeasonality: String(c.forecastSeasonality),
    seasonalities: codes("forecastSeasonality"),
    horizons,
    confidences: codes("forecastConfidence").map(Number),
    adjustments: codes("forecastAdjustment").map((code) => ({ code, value: forecastAdjustmentValue(code) })),
    defaultAdjustment: String(c.forecastAdjustment),
    futurePeriodNames: await upcomingFiscalPeriodNames(orgId, asOf, Math.max(...horizons)),
    model: {
      alpha: c.forecastEtsAlpha,
      beta: c.forecastEtsBeta,
      gamma: c.forecastEtsGamma,
      dampedPhi: c.forecastDampedPhi,
      ma1: c.forecastMa1,
      minCorrelation: c.forecastSeasonalityMinCorr,
      minPeriods: c.forecastSeasonalityMinPeriods,
    },
  };
}

/** The organization's configured budget tolerance, HHI and scenario bands. */
async function healthBands(orgId: string): Promise<{ tolerance: BudgetTolerance; bands: HealthBands; segment: SegmentHealthPolicy }> {
  const c = await analyticsConfig(orgId, "financialHealth");
  const fraction = (pct: number) => decimalRatio(String(pct), "100")!;
  return {
    tolerance: { onTrack: c.budgetOnTrackPercent, watch: c.budgetWatchPercent },
    bands: {
      hhi: { warning: c.segmentHhiWarning, critical: c.segmentHhiCritical },
      scenario: { safety: fraction(c.breakevenSafetyPercent), comfort: fraction(c.breakevenComfortPercent) },
    },
    segment: { target: fraction(c.operatingMarginTarget), warningShare: fraction(c.insightWarningPercent) },
  };
}

/**
 * Preserve ledger amounts through budget variance arithmetic: the variance
 * stays an exact string and its share of the budget an exact fraction —
 * never a float the status bands would misread at an edge.
 */
export function exactBudgetVariance(budget: string, actual: string): { variance: string; variancePct: string | null } {
  const variance = add(actual, neg(budget));
  if (isZero(budget)) return { variance, variancePct: null };
  const variancePct = decimalRatio(variance, abs(budget));
  if (variancePct === null) throw new Error("BUDGET_VARIANCE_RATIO_UNDEFINED");
  return { variance, variancePct };
}

/**
 * Real budget-vs-actual from budget_scenarios / budget_lines (dimensional,
 * account × period). Scenario choice: the newest approved budget covering the
 * range. Drafts never masquerade as official targets; null renders a direct
 * link to the budget authoring workflow.
 * Statuses follow budgetLineStatus above; income favours actual ≥ budget,
 * cost accounts the reverse.
 */
export async function budgetVariance(
  orgId: string,
  from: string,
  to: string,
  allowed: ReadonlySet<string> | null,
  tolerance?: BudgetTolerance,
): Promise<BudgetVariance> {
  // The dashboard threads its one healthBands read through here; direct
  // callers without configured bands read them, exactly once, below.
  const bands = tolerance ?? (await healthBands(orgId)).tolerance;
  const scen = (await analyticsQuery(sql`
    select bs.id, bs.book_id, bs.name, bs.fiscal_year, bs.status
    from budget_scenarios bs
    where bs.org_id = ${orgId} and bs.kind = 'budget' and bs.status = 'approved'
      and exists (
        select 1 from budget_lines bl
        join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
        where bl.org_id = ${orgId} and bl.scenario_id = bs.id and p.starts_on <= ${to} and p.ends_on >= ${from}
          ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, allowed)}
      )
    order by bs.fiscal_year desc, bs.updated_at desc nulls last
    limit 1
  `)) as unknown as { rows: BudgetScenarioSqlRow[] };
  const s = scen.rows[0];
  if (!s) return { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: bands };

  // Both sides arrive per (account, functional) and translate to
  // presentation before the variance compares them — the same second leg as
  // the budget-vs-actual report (see budget-report.ts).
  const r = ((await analyticsQuery(sql`
    with b as (
      select bl.account_id, sub.base_currency as func,
        max(p.ends_on)::text as late,
        sum(case when acc.type in ('income','income_other') then -bl.amount else bl.amount end) as budget
      from budget_lines bl
      join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
      join accounts acc on acc.id = bl.account_id and acc.org_id = bl.org_id
      left join subsidiaries sub on sub.id = bl.subsidiary_id and sub.org_id = bl.org_id
      where bl.org_id = ${orgId} and bl.scenario_id = ${s.id} and p.starts_on <= ${to} and p.ends_on >= ${from}
        ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, allowed)}
      group by 1, 2
    ), a as (
      select l.account_id, sub.base_currency as func,
        max(e.posting_date)::text as late,
        sum(case when acc.type in ('income','income_other') then -l.amount else l.amount end) as actual
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts acc on acc.id = l.account_id and acc.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} and e.book_id = ${s.book_id}
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
        and acc.type in (${PNL_TYPES_SQL})
        and l.posting_date >= ${from} and l.posting_date <= ${to}
      group by 1, 2
    )
    select acc.id, acc.name, acc.type, b.func as b_func, b.late as b_late, a.func as a_func, a.late as a_late,
      coalesce(b.budget, 0) as budget, coalesce(a.actual, 0) as actual
    from accounts acc
    left join b on b.account_id = acc.id
    left join a on a.account_id = acc.id
    where acc.org_id = ${orgId} and acc.type in (${PNL_TYPES_SQL})
      and (b.budget is not null or abs(coalesce(a.actual, 0)) > 0)
  `)));
  const bvaRows = r.rows as unknown as (BudgetAccountSqlRow & {
    b_func: string | null; b_late: string | null; a_func: string | null; a_late: string | null;
  })[];
  // The account × side join fans legs out one row per (account, side,
  // functional); translate each side at its own latest date, then merge.
  const bvaCtx = await flowRates(orgId, [
    ...bvaRows.map((x) => ({ func: x.a_func ?? null, date: String(x.a_late ?? to).slice(0, 10) })),
    ...bvaRows.map((x) => ({ func: x.b_func ?? null, date: String(x.b_late ?? to).slice(0, 10) })),
  ]);
  const bvaByAccount = new Map<string, { name: string; type: string; budget: string; actual: string }>();
  // The account × side join repeats each side's leg once per leg on the
  // other side; each CTE already yields one row per (account, functional),
  // so an identical (account, side, func, date, amount) repeat is join
  // fan-out, not money, and merges exactly once. Null functionals are
  // root-owned legs in org base — they translate 1:1, never drop.
  const seenLeg = new Set<string>();
  const bvaRateAt = (func: string | null, date: string) => bvaCtx.rateAt(func, date);
  for (const x of bvaRows) {
    const prev = bvaByAccount.get(x.id) ?? { name: x.name, type: x.type, budget: "0", actual: "0" };
    const aKey = `${x.id}|a|${x.a_func}|${x.a_late}|${x.actual}`;
    if (!seenLeg.has(aKey)) {
      seenLeg.add(aKey);
      prev.actual = add(
        prev.actual,
        translateAmount(String(x.actual ?? 0), x.a_func ?? null, String(x.a_late ?? to).slice(0, 10), bvaRateAt),
      );
    }
    const bKey = `${x.id}|b|${x.b_func}|${x.b_late}|${x.budget}`;
    if ((x.b_func !== null || x.budget !== null) && !seenLeg.has(bKey)) {
      seenLeg.add(bKey);
      prev.budget = add(
        prev.budget,
        translateAmount(String(x.budget ?? 0), x.b_func ?? null, String(x.b_late ?? to).slice(0, 10), bvaRateAt),
      );
    }
    bvaByAccount.set(x.id, prev);
  }

  const isIncome = (t: string) => t === "income" || t === "income_other";
  // The variance-descending display order the SQL used to provide now
  // applies after translation, on presentation figures.
  const rows: BudgetRow[] = [...bvaByAccount.entries()]
    .map(([accountId, v]): BudgetRow => {
      const budget = v.budget;
      const actual = v.actual;
      const { variance, variancePct } = exactBudgetVariance(budget, actual);
      const favorable = isIncome(v.type) ? cmp(variance, "0") >= 0 : cmp(variance, "0") <= 0;
      const status = budgetLineStatus(v.type, variance, budget, bands);
      return { accountId, name: v.name, type: v.type, budget, actual, variance, variancePct, favorable, status };
    })
    .sort((a, b) => cmp(abs(b.variance), abs(a.variance)));
  return {
    scenario: { id: s.id, name: s.name, fiscalYear: Number(s.fiscal_year), status: s.status },
    rows,
    totals: {
      budget: sum(rows.map((x) => x.budget)),
      actual: sum(rows.map((x) => x.actual)),
      variance: sum(rows.map((x) => x.variance)),
    },
    tolerance: bands,
  };
}
