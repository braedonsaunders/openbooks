import "server-only";
import { addMonthsIso } from "@openbooks/reports";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { utcDateFromParts } from "@openbooks/engine/src/platform/business-date.ts";
import { add, mulDecimal, neg, sum } from "@openbooks/engine/src/money/money.ts";
import { flowRates } from "../fx-presentation";
import { statementBookExpr } from "../gl-summary";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { financialHealth, type FinancialHealth, type HealthBenchmarks } from "./financial-health";
import { englishHealthStrings, type HealthStrings } from "./health-strings";
import { analyticsConfig } from "./config";
import { isFeatureEnabled } from "../features";
import { OPERATING_EXPENSE_TYPES, operatingExpenseRatio } from "./operating-expenses";
import { PNL_COST_TYPES, PNL_TYPES } from "../account-types";
import { getMoneyFormatter } from '../money-server'

/** The canonical operating-expense type list as a SQL `IN` fragment (F-t09-001: one definition). */
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
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  opex: number;
  operatingIncome: number;
  operatingMarginPct: number;
  netIncome: number;
}

export interface PnlLine {
  key: string;
  label: string;
  current: number;
  prior: number;
  change: number;
  changePct: number | null;
  strong?: boolean;
}

export interface MarginStage {
  key: string;
  label: string;
  amount: number; // the flow amount (revenue, -cogs, gp, -opex, opInc, net)
  pctOfRevenue: number;
  kind: "start" | "deduct" | "subtotal" | "total";
}

export interface SegmentRow {
  id: string;
  name: string;
  revenue: number;
  sharePct: number;
  grossProfit: number;
  grossMarginPct: number;
  operatingIncome: number;
  operatingMarginPct: number;
  yoyPct: number | null;
  health: "good" | "warn" | "bad";
}

export interface DriverRow {
  id: string;
  name: string;
  type: string;
  current: number;
  prior: number;
  change: number;
  changePct: number | null;
  contribution: number; // share of total absolute movement
}

export interface ItemRow {
  id: string;
  name: string;
  prior: number;
  current: number;
  change: number;
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
  budget: number;
  actual: number;
  variance: number; // actual − budget (income sign-normalised positive)
  variancePct: number | null;
  favorable: boolean;
  status: "on-track" | "watch" | "over" | "under" | "no-budget";
}

export interface BudgetVariance {
  scenario: { id: string; name: string; fiscalYear: number; status: string } | null;
  rows: BudgetRow[];
  totals: { budget: number; actual: number; variance: number };
}

export interface HealthData extends FinancialHealth {
  monthly: MonthPoint[];
  pnlSummary: PnlLine[];
  marginFlow: MarginStage[];
  segments: { department: SegmentRow[]; class: SegmentRow[]; location: SegmentRow[] };
  drivers: { revenue: DriverRow[]; cost: DriverRow[] };
  items: { rows: ItemRow[]; gainers: ItemRow[]; decliners: ItemRow[]; totalCurrent: number; totalChange: number };
  insights: Insight[];
  budget: BudgetVariance;
  /** Effective benchmark targets driving the grades (org overrides over defaults). */
  benchmarks: HealthBenchmarks;
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
  return Number(amount) === 0 ? "0" : mulDecimal(amount, rateAt(func, date));
}

function priorYear(iso: string): string {
  return addMonthsIso(iso, -12);
}

/** 12-month P&L series ending at the period end (fills gaps with zero). */
async function monthlySeries(
  orgId: string,
  to: string,
  allowed: ReadonlySet<string> | null,
  months = 12,
  strings: HealthStrings = englishHealthStrings,
): Promise<MonthPoint[]> {
  const end = new Date(to + "T00:00:00Z");
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999; month underflow normalizes the same way.
  const start = utcDateFromParts(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1);
  const startIso = start.toISOString().slice(0, 10);
  // A per-month P&L series is the exact shape gl_month_activity stores, so the
  // whole months read straight from it; only the final (possibly partial)
  // month falls back to the lines. The window always starts on a first-of-month.
  const r = ((await db.execute(sql`
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
    const revenue = Number(row?.revenue ?? 0);
    const cogs = Number(row?.cogs ?? 0);
    const opex = Number(row?.opex ?? 0);
    const grossProfit = Number(sum([String(row?.revenue ?? 0), neg(String(row?.cogs ?? 0))]));
    const operatingIncome = Number(sum([String(row?.operating_revenue ?? 0), neg(String(row?.cogs ?? 0)), neg(String(row?.opex ?? 0))]));
    const netIncome = Number(sum([String(row?.revenue ?? 0), neg(String(row?.cogs ?? 0)), neg(String(row?.opex ?? 0)), neg(String(row?.other_exp ?? 0))]));
    out.push({
      month: ym,
      label: strings.monthLabel(ym),
      revenue,
      cogs,
      grossProfit,
      grossMarginPct: revenue > 0 ? grossProfit / revenue : 0,
      opex,
      operatingIncome,
      operatingMarginPct: revenue > 0 ? operatingIncome / revenue : 0,
      netIncome,
    });
  }
  return out;
}

/** Segment breakdown for one dimension (department/class/location) with YoY. */
async function segmentsBy(
  orgId: string,
  dimCol: "department_id" | "class_id" | "location_id",
  dimTable: "departments" | "classes" | "locations",
  from: string,
  to: string,
  allowed: ReadonlySet<string> | null,
  strings: HealthStrings = englishHealthStrings,
): Promise<SegmentRow[]> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const col = sql.raw(`l.${dimCol}`);
  const tbl = sql.raw(dimTable);
  // LEFT JOIN so untagged GL activity lands in an "Unassigned" bucket (the
  // parity) — segment totals then tie out to the P&L instead of silently
  // dropping lines with no dimension.
  // Keep the date predicate on the line for selectivity; the entry controls
  // posted status and the primary accounting book, just as the headline does.
  const r = ((await db.execute(sql`
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
  const totalRev = rows.reduce((a, x) => a + Number(x.revenue), 0) || 1;
  return rows
    .map((x): SegmentRow => {
      const revenue = Number(x.revenue);
      const priorRev = Number(x.prior_revenue);
      const grossProfit = Number(sum([String(x.revenue ?? 0), neg(String(x.cogs ?? 0))]));
      const operatingIncome = Number(sum([String(x.operating_revenue ?? 0), neg(String(x.cogs ?? 0)), neg(String(x.opex ?? 0))]));
      const gmPct = revenue > 0 ? grossProfit / revenue : 0;
      const opPct = revenue > 0 ? operatingIncome / revenue : 0;
      const yoyPct = priorRev > 0 ? (revenue - priorRev) / priorRev : null;
      const health: SegmentRow["health"] = opPct >= 0.1 ? "good" : opPct >= 0 ? "warn" : "bad";
      return {
        id: x.id,
        name: strings.displaySegmentName(x.id, x.name),
        revenue,
        sharePct: revenue / totalRev,
        grossProfit,
        grossMarginPct: gmPct,
        operatingIncome,
        operatingMarginPct: opPct,
        yoyPct,
        health,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

/** Top account-level movers vs prior year, split into revenue and cost. */
async function drivers(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null): Promise<{ revenue: DriverRow[]; cost: DriverRow[] }> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  // Retain the selective line-date predicate while enforcing ledger status/book.
  const r = ((await db.execute(sql`
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
    const sign = isIncome(v.type) ? -1 : 1;
    const current = sign * Number(v.current);
    const prior = sign * Number(v.prior);
    return {
      id,
      name: v.name,
      type: v.type,
      current,
      prior,
      change: current - prior,
      changePct: Math.abs(prior) > 0 ? (current - prior) / Math.abs(prior) : null,
      isIncome: isIncome(v.type),
    };
  });
  const rank = (subset: typeof rows) => {
    const totalMove = subset.reduce((a, x) => a + Math.abs(x.change), 0) || 1;
    return subset
      .map((x): DriverRow => ({ ...x, contribution: Math.abs(x.change) / totalMove }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
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
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const r = ((await db.execute(sql`
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
  const totalChangeAbs =
    ([...itemByAccount.values()]).reduce((a, x) => a + Math.abs(Number(x.current) - Number(x.prior)), 0) || 1;
  const rows = ([...itemByAccount.entries()])
    .map(([id, v]): ItemRow => {
      const current = Number(v.current);
      const prior = Number(v.prior);
      return {
        id,
        name: v.name,
        prior,
        current,
        change: current - prior,
        changePct: Math.abs(prior) > 0 ? (current - prior) / Math.abs(prior) : null,
        contribution: Math.abs(current - prior) / totalChangeAbs,
      };
    })
    .filter((x) => Math.abs(x.current) > 0 || Math.abs(x.prior) > 0)
    .sort((a, b) => b.current - a.current);
  const gainers = [...rows].filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, 5);
  const decliners = [...rows].filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, 5);
  return {
    rows,
    gainers,
    decliners,
    totalCurrent: rows.reduce((a, x) => a + x.current, 0),
    totalChange: rows.reduce((a, x) => a + x.change, 0),
  };
}

function buildPnlSummary(
  f: FinancialHealth["figures"],
  prior: FinancialHealth["figures"],
  strings: HealthStrings = englishHealthStrings,
): PnlLine[] {
  const line = (key: Parameters<HealthStrings["pnlLine"]>[0], current: number, priorV: number, strong?: boolean): PnlLine => ({
    key,
    label: strings.pnlLine(key),
    current,
    prior: priorV,
    change: current - priorV,
    changePct: Math.abs(priorV) > 0 ? (current - priorV) / Math.abs(priorV) : null,
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

function buildMarginFlow(f: FinancialHealth["figures"], strings: HealthStrings = englishHealthStrings): MarginStage[] {
  const rev = f.revenue || 1;
  const pct = (n: number) => n / rev;
  const stage = (key: Parameters<HealthStrings["marginStage"]>[0], amount: number, pctOfRevenue: number, kind: MarginStage["kind"]): MarginStage =>
    ({ key, label: strings.marginStage(key), amount, pctOfRevenue, kind });
  return [
    stage("revenue", f.revenue, 1, "start"),
    stage("cogs", -f.cogs, pct(-f.cogs), "deduct"),
    stage("grossProfit", f.grossProfit, pct(f.grossProfit), "subtotal"),
    stage("opex", -f.opex, pct(-f.opex), "deduct"),
    // Revenue and gross profit include other income, but operating income
    // excludes it. Show both adjustments so each subtotal reconciles.
    stage("excludeOtherIncome", -f.otherIncome, pct(-f.otherIncome), "deduct"),
    stage("operatingIncome", f.operatingIncome, pct(f.operatingIncome), "subtotal"),
    stage("otherIncome", f.otherIncome, pct(f.otherIncome), "deduct"),
    stage("otherExpense", -f.otherExpense, pct(-f.otherExpense), "deduct"),
    stage("netIncome", f.netIncome, pct(f.netIncome), "total"),
  ];
}

/** Derive Issues / Recommendations / Anomalies from ratios + trend. */
function buildInsights(
  base: FinancialHealth,
  monthly: MonthPoint[],
  benchmarks: HealthBenchmarks,
  money: (value: number) => string,
  strings: HealthStrings = englishHealthStrings,
): Insight[] {
  const out: Insight[] = [];
  const f = base.figures;
  const gm = f.revenue > 0 ? f.grossProfit / f.revenue : 0;
  const opm = f.revenue > 0 ? f.operatingIncome / f.revenue : 0;

  // Severity-tiered issues engine, graded against the configured GM/Op
  // benchmarks: critical at 50% of target, warning at 75%.
  const GM_TARGET = benchmarks.grossMargin;
  const OP_TARGET = benchmarks.operatingMargin;
  const pct1 = (n: number): string => (n * 100).toFixed(1);
  if (f.operatingIncome < 0) out.push(strings.operatingLoss(money(f.operatingIncome)));
  if (gm < GM_TARGET * 0.5) out.push(strings.gmCritical(pct1(gm), String(Math.round(GM_TARGET * 100))));
  else if (gm < GM_TARGET * 0.75) out.push(strings.gmWellBelow(pct1(gm), String(Math.round(GM_TARGET * 100))));
  else if (gm < GM_TARGET) out.push(strings.gmBelow(pct1(gm), String(Math.round(GM_TARGET * 100))));
  if (opm >= 0 && opm < OP_TARGET * 0.5) out.push(strings.opmCritical(pct1(opm), String(Math.round(OP_TARGET * 100))));
  else if (opm >= 0 && opm < OP_TARGET) out.push(strings.opmBelow(pct1(opm), String(Math.round(OP_TARGET * 100))));
  if (f.netIncome < 0) out.push(strings.netLoss(money(f.netIncome)));
  if (f.revenueGrowth < -0.15) out.push(strings.revFalling(pct1(Math.abs(f.revenueGrowth))));
  else if (f.revenueGrowth < 0) out.push(strings.revDeclined(pct1(Math.abs(f.revenueGrowth))));
  // Trend rules over the trailing months: revenue slope and margin compression.
  const recent = monthly.filter((m) => m.revenue > 0).slice(-3);
  if (recent.length === 3) {
    const [a, b, c] = recent;
    if (a!.revenue > 0 && c!.revenue < a!.revenue * 0.9)
      out.push(strings.revTrendingDown((((a!.revenue - c!.revenue) / a!.revenue) * 100).toFixed(0)));
    if (a!.grossMarginPct - c!.grossMarginPct > 0.03 && b!.grossMarginPct <= a!.grossMarginPct)
      out.push(strings.marginCompression(((a!.grossMarginPct - c!.grossMarginPct) * 100).toFixed(1)));
  }
  // Safety margin via breakeven.
  if (f.breakevenMonthly !== null && monthly.length > 0) {
    const avgMonthlyRev = f.revenue / Math.max(1, monthly.filter((m) => m.revenue > 0).length);
    const safety = avgMonthlyRev > 0 ? (avgMonthlyRev - f.breakevenMonthly) / avgMonthlyRev : 0;
    if (safety < 0) out.push(strings.belowBreakeven(money(f.breakevenMonthly)));
    else if (safety < 0.1) out.push(strings.thinMargin((safety * 100).toFixed(0)));
  }
  if (f.revenue > 0 && f.opex / f.revenue > 0.4)
    out.push(strings.heavyOverhead(String(operatingExpenseRatio(f.opex, f.revenue))));

  if (gm >= GM_TARGET) out.push(strings.healthyGM);
  if (opm < OP_TARGET && gm >= GM_TARGET * 0.75) out.push(strings.trimOpex);
  if (f.operatingLeverage > 1) out.push(strings.posLeverage(f.operatingLeverage.toFixed(1)));
  if (f.rule40 >= 40) out.push(strings.rule40(f.rule40.toFixed(0)));

  // Anomalies: months whose margin deviates > 2σ from the mean.
  const withRev = monthly.filter((m) => m.revenue > 0);
  if (withRev.length >= 4) {
    const margins = withRev.map((m) => m.grossMarginPct);
    const mean = margins.reduce((a, x) => a + x, 0) / margins.length;
    const sd = Math.sqrt(margins.reduce((a, x) => a + (x - mean) ** 2, 0) / margins.length);
    for (const m of withRev) {
      if (sd > 0 && Math.abs(m.grossMarginPct - mean) > 2 * sd) {
        out.push(strings.marginOutlier(m.label, pct1(m.grossMarginPct), pct1(mean)));
      }
    }
    const revs = withRev.map((m) => m.revenue);
    const rMean = revs.reduce((a, x) => a + x, 0) / revs.length;
    const rSd = Math.sqrt(revs.reduce((a, x) => a + (x - rMean) ** 2, 0) / revs.length);
    for (const m of withRev) {
      if (rSd > 0 && Math.abs(m.revenue - rMean) > 2 * rSd) {
        out.push(strings.revenueSpike(m.label, money(m.revenue), money(rMean)));
      }
    }
  }
  return out;
}

export async function healthData(
  period: { from: string; to: string; label: string },
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  strings: HealthStrings = englishHealthStrings,
): Promise<HealthData> {
  const { money: formatMoney } = await getMoneyFormatter(orgId)
  const money = (value: number) => formatMoney(value, { maximumFractionDigits: 0 })
  const { from, to } = period;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);

  // Per-org benchmark targets (percent-scale in the store → decimals here).
  const cfg = await analyticsConfig(orgId, "financialHealth");
  // mergeConfig always materializes every default key for the dashboard.
  const benchmarks: HealthBenchmarks = {
    grossMargin: cfg.grossMarginTarget! / 100,
    operatingMargin: cfg.operatingMarginTarget! / 100,
    ebitdaMargin: cfg.ebitdaMarginTarget! / 100,
    netMargin: cfg.netMarginTarget! / 100,
    roa: cfg.roaTarget! / 100,
    roe: cfg.roeTarget! / 100,
    roic: cfg.roicTarget! / 100,
    revenuePerEmployee: cfg.revenuePerEmployee!,
    gpPerEmployee: cfg.gpPerEmployee!,
  };

  const emptyBudget = (): BudgetVariance => ({ scenario: null, rows: [], totals: { budget: 0, actual: 0, variance: 0 } });
  const budgetsOn = await isFeatureEnabled(orgId, "budgets");

  const [base, priorBase, monthly, dept, cls, loc, drv, items, budget] = await Promise.all([
    financialHealth(period, benchmarks, orgId, allowedSubsidiaryIds, strings),
    financialHealth({ from: pFrom, to: pTo, label: "prior" }, benchmarks, orgId, allowedSubsidiaryIds, strings),
    monthlySeries(orgId, to, allowedSubsidiaryIds, 12, strings),
    segmentsBy(orgId, "department_id", "departments", from, to, allowedSubsidiaryIds, strings),
    segmentsBy(orgId, "class_id", "classes", from, to, allowedSubsidiaryIds, strings),
    segmentsBy(orgId, "location_id", "locations", from, to, allowedSubsidiaryIds, strings),
    drivers(orgId, from, to, allowedSubsidiaryIds),
    itemAnalysis(orgId, from, to, allowedSubsidiaryIds),
    budgetsOn
      ? budgetVariance(orgId, from, to, allowedSubsidiaryIds)
      : Promise.resolve(emptyBudget()),
  ]);

  return {
    ...base,
    monthly,
    pnlSummary: buildPnlSummary(base.figures, priorBase.figures, strings),
    marginFlow: buildMarginFlow(base.figures, strings),
    segments: { department: dept, class: cls, location: loc },
    drivers: drv,
    items,
    budget,
    insights: buildInsights(base, monthly, benchmarks, money, strings),
    benchmarks,
  };
}

/**
 * Budget-line status rule (F-t09-004): on-track when favorable or within
 * 10%, watch to 25%, and beyond that the direction keeps its meaning —
 * overspent cost lines read "over", missed revenue lines read "under".
 * Flagging a revenue shortfall as over-budget spend inverts the story, so
 * income and cost have distinct unfavorable-beyond-tolerance statuses while
 * sharing the neutral watch band. Exported for unit tests.
 */
export function budgetLineStatus(
  type: string,
  variance: number,
  variancePct: number | null,
  budget: number,
): BudgetRow["status"] {
  const favorable = type === "income" || type === "income_other" ? variance >= 0 : variance <= 0;
  if (budget === 0) return "no-budget";
  if (favorable || Math.abs(variancePct ?? 0) <= 0.1) return "on-track";
  if (Math.abs(variancePct ?? 0) <= 0.25) return "watch";
  return type === "income" || type === "income_other" ? "under" : "over";
}

/**
 * Real budget-vs-actual from budget_scenarios / budget_lines (dimensional,
 * account × period). Scenario choice: the newest approved budget covering the
 * range. Drafts never masquerade as official targets; null renders a direct
 * link to the budget authoring workflow.
 * Statuses follow budgetLineStatus above; income favours actual ≥ budget,
 * cost accounts the reverse.
 */
async function budgetVariance(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null): Promise<BudgetVariance> {
  const scen = (await db.execute(sql`
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
  if (!s) return { scenario: null, rows: [], totals: { budget: 0, actual: 0, variance: 0 } };

  // Both sides arrive per (account, functional) and translate to
  // presentation before the variance compares them — the same second leg as
  // the budget-vs-actual report (see budget-report.ts).
  const r = ((await db.execute(sql`
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
      const budget = Number(v.budget);
      const actual = Number(v.actual);
      const variance = actual - budget;
      const variancePct = Math.abs(budget) > 0 ? variance / Math.abs(budget) : null;
      const favorable = isIncome(v.type) ? variance >= 0 : variance <= 0;
      const status = budgetLineStatus(v.type, variance, variancePct, budget);
      return { accountId, name: v.name, type: v.type, budget, actual, variance, variancePct, favorable, status };
    })
    .sort((a, b) => Math.abs(b.actual - b.budget) - Math.abs(a.actual - a.budget));
  return {
    scenario: { id: s.id, name: s.name, fiscalYear: Number(s.fiscal_year), status: s.status },
    rows,
    totals: {
      budget: rows.reduce((a, x) => a + x.budget, 0),
      actual: rows.reduce((a, x) => a + x.actual, 0),
      variance: rows.reduce((a, x) => a + x.variance, 0),
    },
  };
}
