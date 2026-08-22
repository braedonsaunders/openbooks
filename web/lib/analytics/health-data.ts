import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { financialHealth, type FinancialHealth, type HealthBenchmarks } from "./financial-health";
import { analyticsConfig } from "./config";
import { isFeatureEnabled } from "../features";
import { getMoneyFormatter } from '../money-server'

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
  status: "on-track" | "watch" | "over" | "no-budget";
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

const PNL_TYPES = ["income", "income_other", "cogs", "expense", "expense_other", "expense_deferred"] as const;

function priorYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} '${String(y).slice(2)}`;
}

/** 12-month P&L series ending at the period end (fills gaps with zero). */
async function monthlySeries(orgId: string, to: string, months = 12): Promise<MonthPoint[]> {
  const end = new Date(to + "T00:00:00Z");
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));
  const startIso = start.toISOString().slice(0, 10);
  // A per-month P&L series is the exact shape gl_month_activity stores, so the
  // whole months read straight from it; only the final (possibly partial)
  // month falls back to the lines. The window always starts on a first-of-month.
  const r = (await db.execute(sql`
    with movement as (
      select g.account_id, to_char(g.month, 'YYYY-MM') as month,
             (g.debit_total - g.credit_total) as amt
        from gl_month_activity g
       where g.org_id = ${orgId}
         and g.month >= ${startIso}::date
         and g.month < date_trunc('month', ${to}::date)::date
      union all
      select l.account_id, to_char(e.posting_date, 'YYYY-MM'), l.amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
         and e.posting_date >= date_trunc('month', ${to}::date)::date
         and e.posting_date <= ${to}
       where l.org_id = ${orgId}
    )
    select m.month,
      -sum(case when a.type in ('income','income_other') then m.amt else 0 end) as revenue,
      sum(case when a.type = 'cogs' then m.amt else 0 end) as cogs,
      sum(case when a.type in ('expense','expense_deferred') then m.amt else 0 end) as opex,
      sum(case when a.type = 'expense_other' then m.amt else 0 end) as other_exp
    from movement m
    join accounts a on a.id = m.account_id and a.org_id = ${orgId}
    where a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
    group by 1
  `)) as any;
  const by = new Map<string, any>(r.rows.map((x: any) => [x.month, x]));
  const out: MonthPoint[] = [];
  for (let i = 0; i < months; i++) {
    const dt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    const row = by.get(ym);
    const revenue = Number(row?.revenue ?? 0);
    const cogs = Number(row?.cogs ?? 0);
    const opex = Number(row?.opex ?? 0);
    const otherExp = Number(row?.other_exp ?? 0);
    const grossProfit = revenue - cogs;
    const operatingIncome = revenue - cogs - opex;
    const netIncome = operatingIncome - otherExp;
    out.push({
      month: ym,
      label: monthLabel(ym),
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
): Promise<SegmentRow[]> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const col = sql.raw(`l.${dimCol}`);
  const tbl = sql.raw(dimTable);
  // LEFT JOIN so untagged GL activity lands in an "Unassigned" bucket (the
  // parity) — segment totals then tie out to the P&L instead of silently
  // dropping lines with no dimension.
  // No entry join: the line carries its own posting date, so the window is a
  // plain predicate on journal_lines instead of a join whose date filter the
  // planner applied only after walking every P&L line ever posted.
  const r = (await db.execute(sql`
    select coalesce(d.id::text, 'unassigned') as id, coalesce(d.name, 'Unassigned') as name,
      -sum(case when a.type in ('income','income_other') and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as revenue,
      sum(case when a.type = 'cogs' and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as cogs,
      sum(case when a.type in ('expense','expense_deferred') and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as opex,
      -sum(case when a.type in ('income','income_other') and l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.amount else 0 end) as prior_revenue
    from journal_lines l
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    left join ${tbl} d on d.id = ${col} and d.org_id = l.org_id
    where l.org_id = ${orgId}
      and a.type in ('income','income_other','cogs','expense','expense_deferred')
      and l.posting_date >= ${pFrom} and l.posting_date <= ${to}
    group by 1, 2
    having abs(-sum(case when a.type in ('income','income_other') and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end)) > 0
        or abs(sum(case when a.type in ('cogs','expense','expense_deferred') and l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end)) > 0
  `)) as any;
  const rows = r.rows as any[];
  // A dimension nobody tags is unused, not "one big Unassigned segment" — keep
  // the empty state in that case.
  if (rows.every((x) => x.id === "unassigned")) return [];
  const totalRev = rows.reduce((a, x) => a + Number(x.revenue), 0) || 1;
  return rows
    .map((x): SegmentRow => {
      const revenue = Number(x.revenue);
      const cogs = Number(x.cogs);
      const opex = Number(x.opex);
      const priorRev = Number(x.prior_revenue);
      const grossProfit = revenue - cogs;
      const operatingIncome = revenue - cogs - opex;
      const gmPct = revenue > 0 ? grossProfit / revenue : 0;
      const opPct = revenue > 0 ? operatingIncome / revenue : 0;
      const yoyPct = priorRev > 0 ? (revenue - priorRev) / priorRev : null;
      const health: SegmentRow["health"] = opPct >= 0.1 ? "good" : opPct >= 0 ? "warn" : "bad";
      return {
        id: x.id,
        name: x.name,
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
async function drivers(orgId: string, from: string, to: string): Promise<{ revenue: DriverRow[]; cost: DriverRow[] }> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  // No entry join: the line carries its own posting date.
  const r = (await db.execute(sql`
    select a.id, a.name, a.type,
      sum(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as cur_raw,
      sum(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.amount else 0 end) as prior_raw
    from journal_lines l
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = ${orgId}
      and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
      and l.posting_date >= ${pFrom} and l.posting_date <= ${to}
    group by a.id, a.name, a.type
  `)) as any;
  const isIncome = (t: string) => t === "income" || t === "income_other";
  const rows = (r.rows as any[]).map((x) => {
    const sign = isIncome(x.type) ? -1 : 1;
    const current = sign * Number(x.cur_raw);
    const prior = sign * Number(x.prior_raw);
    return {
      id: x.id as string,
      name: x.name as string,
      type: x.type as string,
      current,
      prior,
      change: current - prior,
      changePct: Math.abs(prior) > 0 ? (current - prior) / Math.abs(prior) : null,
      isIncome: isIncome(x.type),
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
async function itemAnalysis(orgId: string, from: string, to: string): Promise<HealthData["items"]> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  let rows: ItemRow[] = [];
  try {
    const r = (await db.execute(sql`
      select a.id, a.name,
        -sum(case when l.posting_date >= ${from} and l.posting_date <= ${to} then l.amount else 0 end) as current,
        -sum(case when l.posting_date >= ${pFrom} and l.posting_date <= ${pTo} then l.amount else 0 end) as prior
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId}
        and a.type in ('income','income_other')
        and l.posting_date >= ${pFrom} and l.posting_date <= ${to}
      group by a.id, a.name
    `)) as any;
    const totalChangeAbs =
      (r.rows as any[]).reduce((a, x) => a + Math.abs(Number(x.current) - Number(x.prior)), 0) || 1;
    rows = (r.rows as any[])
      .map((x): ItemRow => {
        const current = Number(x.current);
        const prior = Number(x.prior);
        return {
          id: x.id,
          name: x.name,
          prior,
          current,
          change: current - prior,
          changePct: Math.abs(prior) > 0 ? (current - prior) / Math.abs(prior) : null,
          contribution: Math.abs(current - prior) / totalChangeAbs,
        };
      })
      .filter((x) => Math.abs(x.current) > 0 || Math.abs(x.prior) > 0)
      .sort((a, b) => b.current - a.current);
  } catch {
    rows = [];
  }
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

function buildPnlSummary(f: FinancialHealth["figures"], prior: FinancialHealth["figures"]): PnlLine[] {
  const line = (key: string, label: string, current: number, priorV: number, strong?: boolean): PnlLine => ({
    key,
    label,
    current,
    prior: priorV,
    change: current - priorV,
    changePct: Math.abs(priorV) > 0 ? (current - priorV) / Math.abs(priorV) : null,
    strong,
  });
  return [
    line("revenue", "Revenue", f.revenue, prior.revenue, true),
    line("cogs", "Cost of Goods Sold", f.cogs, prior.cogs),
    line("grossProfit", "Gross Profit", f.grossProfit, prior.grossProfit, true),
    line("opex", "Operating Expenses", f.opex, prior.opex),
    line("operatingIncome", "Operating Income", f.operatingIncome, prior.operatingIncome, true),
    line("otherExpense", "Other Expense", f.otherExpense, prior.otherExpense),
    line("netIncome", "Net Income", f.netIncome, prior.netIncome, true),
  ];
}

function buildMarginFlow(f: FinancialHealth["figures"]): MarginStage[] {
  const rev = f.revenue || 1;
  const pct = (n: number) => n / rev;
  return [
    { key: "revenue", label: "Revenue", amount: f.revenue, pctOfRevenue: 1, kind: "start" },
    { key: "cogs", label: "COGS", amount: -f.cogs, pctOfRevenue: pct(-f.cogs), kind: "deduct" },
    { key: "grossProfit", label: "Gross Profit", amount: f.grossProfit, pctOfRevenue: pct(f.grossProfit), kind: "subtotal" },
    { key: "opex", label: "Operating Expenses", amount: -f.opex, pctOfRevenue: pct(-f.opex), kind: "deduct" },
    { key: "operatingIncome", label: "Operating Income", amount: f.operatingIncome, pctOfRevenue: pct(f.operatingIncome), kind: "subtotal" },
    { key: "otherExpense", label: "Other Expense", amount: -f.otherExpense, pctOfRevenue: pct(-f.otherExpense), kind: "deduct" },
    { key: "netIncome", label: "Net Income", amount: f.netIncome, pctOfRevenue: pct(f.netIncome), kind: "total" },
  ];
}

/** Derive Issues / Recommendations / Anomalies from ratios + trend. */
function buildInsights(base: FinancialHealth, monthly: MonthPoint[], benchmarks: HealthBenchmarks, money: (value: number) => string): Insight[] {
  const out: Insight[] = [];
  const f = base.figures;
  const gm = f.revenue > 0 ? f.grossProfit / f.revenue : 0;
  const opm = f.revenue > 0 ? f.operatingIncome / f.revenue : 0;

  // Severity-tiered issues engine, graded against the configured GM/Op
  // benchmarks: critical at 50% of target, warning at 75%.
  const GM_TARGET = benchmarks.grossMargin;
  const OP_TARGET = benchmarks.operatingMargin;
  if (f.operatingIncome < 0) out.push({ severity: "issue", title: "Operating loss", detail: `Operating income is ${money(f.operatingIncome)} — the business loses money before other items.` });
  if (gm < GM_TARGET * 0.5) out.push({ severity: "issue", title: "Gross margin critically low", detail: `Gross margin is ${(gm * 100).toFixed(1)}% — less than half the ${Math.round(GM_TARGET * 100)}% target.` });
  else if (gm < GM_TARGET * 0.75) out.push({ severity: "issue", title: "Gross margin well below target", detail: `Gross margin is ${(gm * 100).toFixed(1)}% vs the ${Math.round(GM_TARGET * 100)}% target.` });
  else if (gm < GM_TARGET) out.push({ severity: "issue", title: "Gross margin below target", detail: `Gross margin is ${(gm * 100).toFixed(1)}% vs a ${Math.round(GM_TARGET * 100)}% benchmark.` });
  if (opm >= 0 && opm < OP_TARGET * 0.5) out.push({ severity: "issue", title: "Operating margin critically low", detail: `Operating margin is ${(opm * 100).toFixed(1)}% — less than half the ${Math.round(OP_TARGET * 100)}% target.` });
  else if (opm >= 0 && opm < OP_TARGET) out.push({ severity: "issue", title: "Operating margin below target", detail: `Operating margin is ${(opm * 100).toFixed(1)}% vs a ${Math.round(OP_TARGET * 100)}% benchmark.` });
  if (f.netIncome < 0) out.push({ severity: "issue", title: "Net loss for the period", detail: `Net income is ${money(f.netIncome)}.` });
  if (f.revenueGrowth < -0.15) out.push({ severity: "issue", title: "Revenue falling sharply year-over-year", detail: `Revenue is down ${(Math.abs(f.revenueGrowth) * 100).toFixed(1)}% vs the prior year.` });
  else if (f.revenueGrowth < 0) out.push({ severity: "issue", title: "Revenue declined year-over-year", detail: `Revenue is down ${(Math.abs(f.revenueGrowth) * 100).toFixed(1)}% vs the prior year.` });
  // Trend rules over the trailing months: revenue slope and margin compression.
  const recent = monthly.filter((m) => m.revenue > 0).slice(-3);
  if (recent.length === 3) {
    const [a, b, c] = recent;
    if (a!.revenue > 0 && c!.revenue < a!.revenue * 0.9)
      out.push({ severity: "issue", title: "Revenue trending down", detail: `Revenue fell ${(((a!.revenue - c!.revenue) / a!.revenue) * 100).toFixed(0)}% across the last three active months.` });
    if (a!.grossMarginPct - c!.grossMarginPct > 0.03 && b!.grossMarginPct <= a!.grossMarginPct)
      out.push({ severity: "issue", title: "Margin compression", detail: `Gross margin slid ${((a!.grossMarginPct - c!.grossMarginPct) * 100).toFixed(1)}pp over the last three active months.` });
  }
  // Safety margin via breakeven.
  if (f.breakevenMonthly !== null && monthly.length > 0) {
    const avgMonthlyRev = f.revenue / Math.max(1, monthly.filter((m) => m.revenue > 0).length);
    const safety = avgMonthlyRev > 0 ? (avgMonthlyRev - f.breakevenMonthly) / avgMonthlyRev : 0;
    if (safety < 0) out.push({ severity: "issue", title: "Below breakeven", detail: `Average monthly revenue is under the approximately ${money(f.breakevenMonthly)} breakeven.` });
    else if (safety < 0.1) out.push({ severity: "issue", title: "Thin safety margin", detail: `Only ${(safety * 100).toFixed(0)}% of monthly revenue separates you from breakeven.` });
  }
  if (f.revenue > 0 && f.opex / f.revenue > 0.4)
    out.push({ severity: "issue", title: "Heavy overhead", detail: `Operating expenses are ${((f.opex / f.revenue) * 100).toFixed(0)}% of revenue (>40%).` });

  if (gm >= GM_TARGET) out.push({ severity: "rec", title: "Healthy gross margin", detail: "Direct-cost discipline is on track — protect pricing." });
  if (opm < OP_TARGET && gm >= GM_TARGET * 0.75) out.push({ severity: "rec", title: "Trim operating expense", detail: "Gross margin is fine; the gap to operating margin is overhead — review OpEx." });
  if (f.operatingLeverage > 1) out.push({ severity: "rec", title: "Positive operating leverage", detail: `Operating income scales ${f.operatingLeverage.toFixed(1)}× revenue — lean into growth.` });
  if (f.rule40 >= 40) out.push({ severity: "rec", title: "Passing the Rule of 40", detail: `Growth + margin = ${f.rule40.toFixed(0)}.` });

  // Anomalies: months whose margin deviates > 2σ from the mean.
  const withRev = monthly.filter((m) => m.revenue > 0);
  if (withRev.length >= 4) {
    const margins = withRev.map((m) => m.grossMarginPct);
    const mean = margins.reduce((a, x) => a + x, 0) / margins.length;
    const sd = Math.sqrt(margins.reduce((a, x) => a + (x - mean) ** 2, 0) / margins.length);
    for (const m of withRev) {
      if (sd > 0 && Math.abs(m.grossMarginPct - mean) > 2 * sd) {
        out.push({ severity: "anomaly", title: `Margin outlier in ${m.label}`, detail: `Gross margin ${(m.grossMarginPct * 100).toFixed(1)}% vs ${(mean * 100).toFixed(1)}% average.` });
      }
    }
    const revs = withRev.map((m) => m.revenue);
    const rMean = revs.reduce((a, x) => a + x, 0) / revs.length;
    const rSd = Math.sqrt(revs.reduce((a, x) => a + (x - rMean) ** 2, 0) / revs.length);
    for (const m of withRev) {
      if (rSd > 0 && Math.abs(m.revenue - rMean) > 2 * rSd) {
        out.push({ severity: "anomaly", title: `Revenue spike/dip in ${m.label}`, detail: `Revenue ${money(m.revenue)} vs ${money(rMean)} average.` });
      }
    }
  }
  return out;
}

export async function healthData(period: { from: string; to: string; label: string }, orgId: string): Promise<HealthData> {
  const { money: formatMoney } = await getMoneyFormatter(orgId)
  const money = (value: number) => formatMoney(value, { maximumFractionDigits: 0 })
  const { from, to } = period;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);

  // Per-org benchmark targets (percent-scale in the store → decimals here).
  const cfg = await analyticsConfig(orgId, "financialHealth");
  const benchmarks: HealthBenchmarks = {
    grossMargin: cfg.grossMarginTarget / 100,
    operatingMargin: cfg.operatingMarginTarget / 100,
    ebitdaMargin: cfg.ebitdaMarginTarget / 100,
    netMargin: cfg.netMarginTarget / 100,
    roa: cfg.roaTarget / 100,
    roe: cfg.roeTarget / 100,
    roic: cfg.roicTarget / 100,
    revenuePerEmployee: cfg.revenuePerEmployee,
    gpPerEmployee: cfg.gpPerEmployee,
  };

  const emptyBudget = (): BudgetVariance => ({ scenario: null, rows: [], totals: { budget: 0, actual: 0, variance: 0 } });
  const budgetsOn = await isFeatureEnabled(orgId, "budgets");

  const [base, priorBase, monthly, dept, cls, loc, drv, items, budget] = await Promise.all([
    financialHealth(period, benchmarks, orgId),
    financialHealth({ from: pFrom, to: pTo, label: "prior" }, benchmarks, orgId),
    monthlySeries(orgId, to),
    segmentsBy(orgId, "department_id", "departments", from, to).catch(() => []),
    segmentsBy(orgId, "class_id", "classes", from, to).catch(() => []),
    segmentsBy(orgId, "location_id", "locations", from, to).catch(() => []),
    drivers(orgId, from, to),
    itemAnalysis(orgId, from, to),
    budgetsOn
      ? budgetVariance(orgId, from, to).catch(emptyBudget)
      : Promise.resolve(emptyBudget()),
  ]);

  return {
    ...base,
    monthly,
    pnlSummary: buildPnlSummary(base.figures, priorBase.figures),
    marginFlow: buildMarginFlow(base.figures),
    segments: { department: dept, class: cls, location: loc },
    drivers: drv,
    items,
    budget,
    insights: buildInsights(base, monthly, benchmarks, money),
    benchmarks,
  };
}

/**
 * Real budget-vs-actual from budget_scenarios / budget_lines (dimensional,
 * account × period). Scenario choice: the newest approved budget covering the
 * range. Drafts never masquerade as official targets; null renders a direct
 * link to the budget authoring workflow.
 * Statuses use a ±10% variance rule: on-track when favorable or within
 * 10%, watch to 25%, over beyond; income favours actual ≥ budget, cost
 * accounts the reverse.
 */
async function budgetVariance(orgId: string, from: string, to: string): Promise<BudgetVariance> {
  const scen = (await db.execute(sql`
    select bs.id, bs.book_id, bs.name, bs.fiscal_year, bs.status
    from budget_scenarios bs
    where bs.org_id = ${orgId} and bs.kind = 'budget' and bs.status = 'approved'
      and exists (
        select 1 from budget_lines bl
        join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
        where bl.org_id = ${orgId} and bl.scenario_id = bs.id and p.starts_on <= ${to} and p.ends_on >= ${from}
      )
    order by bs.fiscal_year desc, bs.updated_at desc nulls last
    limit 1
  `)) as any;
  const s = scen.rows[0];
  if (!s) return { scenario: null, rows: [], totals: { budget: 0, actual: 0, variance: 0 } };

  const r = (await db.execute(sql`
    with b as (
      select bl.account_id, sum(case when acc.type in ('income','income_other') then -bl.amount else bl.amount end) as budget
      from budget_lines bl
      join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
      join accounts acc on acc.id = bl.account_id and acc.org_id = bl.org_id
      where bl.org_id = ${orgId} and bl.scenario_id = ${s.id} and p.starts_on <= ${to} and p.ends_on >= ${from}
      group by 1
    ), a as (
      select l.account_id,
        sum(case when acc.type in ('income','income_other') then -l.amount else l.amount end) as actual
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts acc on acc.id = l.account_id and acc.org_id = l.org_id
      where l.org_id = ${orgId} and e.book_id = ${s.book_id}
        and acc.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
        and l.posting_date >= ${from} and l.posting_date <= ${to}
      group by 1
    )
    select acc.id, acc.name, acc.type,
      coalesce(b.budget, 0) as budget, coalesce(a.actual, 0) as actual
    from accounts acc
    left join b on b.account_id = acc.id
    left join a on a.account_id = acc.id
    where acc.org_id = ${orgId} and acc.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
      and (b.budget is not null or abs(coalesce(a.actual, 0)) > 0)
    order by abs(coalesce(a.actual, 0) - coalesce(b.budget, 0)) desc
  `)) as any;

  const isIncome = (t: string) => t === "income" || t === "income_other";
  const rows: BudgetRow[] = (r.rows as any[]).map((x) => {
    const budget = Number(x.budget);
    const actual = Number(x.actual);
    const variance = actual - budget;
    const variancePct = Math.abs(budget) > 0 ? variance / Math.abs(budget) : null;
    const favorable = isIncome(x.type) ? variance >= 0 : variance <= 0;
    let status: BudgetRow["status"];
    if (budget === 0) status = "no-budget";
    else if (favorable || Math.abs(variancePct ?? 0) <= 0.1) status = "on-track";
    else if (Math.abs(variancePct ?? 0) <= 0.25) status = "watch";
    else status = "over";
    return { accountId: x.id, name: x.name, type: x.type, budget, actual, variance, variancePct, favorable, status };
  });
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
