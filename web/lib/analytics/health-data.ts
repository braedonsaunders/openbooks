import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { financialHealth, type FinancialHealth } from "./financial-health";

/**
 * Full data payload for the Financial Health dashboard — everything the 10
 * tabs need, sourced natively from the openbooks GL (+ invoice doc lines for
 * item revenue). Ported from Gantry's Lib_Health_Data.js shapes.
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

export interface HealthData extends FinancialHealth {
  monthly: MonthPoint[];
  pnlSummary: PnlLine[];
  marginFlow: MarginStage[];
  segments: { department: SegmentRow[]; class: SegmentRow[]; location: SegmentRow[] };
  drivers: { revenue: DriverRow[]; cost: DriverRow[] };
  items: { rows: ItemRow[]; gainers: ItemRow[]; decliners: ItemRow[]; totalCurrent: number; totalChange: number };
  insights: Insight[];
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
async function monthlySeries(to: string, months = 12): Promise<MonthPoint[]> {
  const end = new Date(to + "T00:00:00Z");
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));
  const startIso = start.toISOString().slice(0, 10);
  const r = (await db.execute(sql`
    select to_char(e.posting_date, 'YYYY-MM') as month,
      -sum(case when a.type in ('income','income_other') then l.amount else 0 end) as revenue,
      sum(case when a.type = 'cogs' then l.amount else 0 end) as cogs,
      sum(case when a.type in ('expense','expense_deferred') then l.amount else 0 end) as opex,
      sum(case when a.type = 'expense_other' then l.amount else 0 end) as other_exp
    from journal_lines l
    join accounts a on a.id = l.account_id
    join journal_entries e on e.id = l.entry_id
    where e.posting_date >= ${startIso} and e.posting_date <= ${to}
      and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
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
  dimCol: "department_id" | "class_id" | "location_id",
  dimTable: "departments" | "classes" | "locations",
  from: string,
  to: string,
): Promise<SegmentRow[]> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const col = sql.raw(`l.${dimCol}`);
  const tbl = sql.raw(dimTable);
  const r = (await db.execute(sql`
    select d.id, d.name,
      -sum(case when a.type in ('income','income_other') and e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as revenue,
      sum(case when a.type = 'cogs' and e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as cogs,
      sum(case when a.type in ('expense','expense_deferred') and e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as opex,
      -sum(case when a.type in ('income','income_other') and e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior_revenue
    from journal_lines l
    join accounts a on a.id = l.account_id
    join journal_entries e on e.id = l.entry_id
    join ${tbl} d on d.id = ${col}
    where a.type in ('income','income_other','cogs','expense','expense_deferred')
      and e.posting_date >= ${pFrom} and e.posting_date <= ${to}
    group by d.id, d.name
    having abs(-sum(case when a.type in ('income','income_other') and e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end)) > 0.005
  `)) as any;
  const rows = r.rows as any[];
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
async function drivers(from: string, to: string): Promise<{ revenue: DriverRow[]; cost: DriverRow[] }> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const r = (await db.execute(sql`
    select a.id, a.name, a.type,
      sum(case when e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as cur_raw,
      sum(case when e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior_raw
    from journal_lines l
    join accounts a on a.id = l.account_id
    join journal_entries e on e.id = l.entry_id
    where a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
      and e.posting_date >= ${pFrom} and e.posting_date <= ${to}
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
      changePct: Math.abs(prior) > 0.005 ? (current - prior) / Math.abs(prior) : null,
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
async function itemAnalysis(from: string, to: string): Promise<HealthData["items"]> {
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  let rows: ItemRow[] = [];
  try {
    const r = (await db.execute(sql`
      select a.id, a.name,
        -sum(case when e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as current,
        -sum(case when e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where a.type in ('income','income_other')
        and e.posting_date >= ${pFrom} and e.posting_date <= ${to}
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
          changePct: Math.abs(prior) > 0.005 ? (current - prior) / Math.abs(prior) : null,
          contribution: Math.abs(current - prior) / totalChangeAbs,
        };
      })
      .filter((x) => Math.abs(x.current) > 0.005 || Math.abs(x.prior) > 0.005)
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
    changePct: Math.abs(priorV) > 0.005 ? (current - priorV) / Math.abs(priorV) : null,
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
function buildInsights(base: FinancialHealth, monthly: MonthPoint[]): Insight[] {
  const out: Insight[] = [];
  const f = base.figures;
  const gm = f.revenue > 0 ? f.grossProfit / f.revenue : 0;
  const opm = f.revenue > 0 ? f.operatingIncome / f.revenue : 0;

  if (gm < 0.4) out.push({ severity: "issue", title: "Gross margin below target", detail: `Gross margin is ${(gm * 100).toFixed(1)}% vs a 40% benchmark.` });
  if (opm < 0.15) out.push({ severity: "issue", title: "Operating margin below target", detail: `Operating margin is ${(opm * 100).toFixed(1)}% vs a 15% benchmark.` });
  if (f.netIncome < 0) out.push({ severity: "issue", title: "Net loss for the period", detail: `Net income is ${f.netIncome < 0 ? "-" : ""}$${Math.abs(f.netIncome).toLocaleString()}.` });
  if (f.revenueGrowth < 0) out.push({ severity: "issue", title: "Revenue declined year-over-year", detail: `Revenue is down ${(Math.abs(f.revenueGrowth) * 100).toFixed(1)}% vs the prior year.` });

  if (gm >= 0.4) out.push({ severity: "rec", title: "Healthy gross margin", detail: "Direct-cost discipline is on track — protect pricing." });
  if (opm < 0.15 && gm >= 0.3) out.push({ severity: "rec", title: "Trim operating expense", detail: "Gross margin is fine; the gap to operating margin is overhead — review OpEx." });
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
        out.push({ severity: "anomaly", title: `Revenue spike/dip in ${m.label}`, detail: `Revenue $${Math.round(m.revenue).toLocaleString()} vs $${Math.round(rMean).toLocaleString()} average.` });
      }
    }
  }
  return out;
}

export async function healthData(period: { from: string; to: string; label: string }): Promise<HealthData> {
  const { from, to } = period;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);

  const [base, priorBase, monthly, dept, cls, loc, drv, items] = await Promise.all([
    financialHealth(period),
    financialHealth({ from: pFrom, to: pTo, label: "prior" }),
    monthlySeries(to),
    segmentsBy("department_id", "departments", from, to).catch(() => []),
    segmentsBy("class_id", "classes", from, to).catch(() => []),
    segmentsBy("location_id", "locations", from, to).catch(() => []),
    drivers(from, to),
    itemAnalysis(from, to),
  ]);

  return {
    ...base,
    monthly,
    pnlSummary: buildPnlSummary(base.figures, priorBase.figures),
    marginFlow: buildMarginFlow(base.figures),
    segments: { department: dept, class: cls, location: loc },
    drivers: drv,
    items,
    insights: buildInsights(base, monthly),
  };
}
