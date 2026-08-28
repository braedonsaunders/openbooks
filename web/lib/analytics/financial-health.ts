import "server-only";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { profitAndLoss, balanceSheet, type StatementRow } from "../reports";
import { resolveOrgId } from "../org-scope";
import { decimalSum, type ExactDecimal } from '../statement-format'

/**
 * Financial Health — the ratio + scorecard engine behind
 * /analytics/financial-health.
 *
 * Every figure is sourced natively from OpenBooks' own GL and derives from
 * profitAndLoss()/balanceSheet(), so the numbers tie out
 * to the P&L and Balance Sheet reports exactly. No source platform, no Plotly.
 *
 * Sign convention follows web/lib/reports.ts — statement values are already
 * reader-signed (revenue positive, expense positive).
 */

export type Grade = "A" | "B" | "C" | "D" | "F";
export type RatioCategory = "profitability" | "efficiency" | "operating";

/**
 * Benchmark targets behind the letter grades — editable per organization from
 * the Configuration tab. Margins/returns are decimals (0.4 = 40%); the two
 * productivity benchmarks are dollars.
 */
export interface HealthBenchmarks {
  grossMargin: number;
  operatingMargin: number;
  ebitdaMargin: number;
  netMargin: number;
  roa: number;
  roe: number;
  roic: number;
  revenuePerEmployee: number;
  gpPerEmployee: number;
}

export const DEFAULT_BENCHMARKS: HealthBenchmarks = {
  grossMargin: 0.4,
  operatingMargin: 0.15,
  ebitdaMargin: 0.2,
  netMargin: 0.1,
  roa: 0.08,
  roe: 0.15,
  roic: 0.12,
  revenuePerEmployee: 200_000,
  gpPerEmployee: 80_000,
};

export interface RatioResult {
  id: string;
  /** value in native units — decimal for pct (0.25), dollars for money, x for num/raw */
  value: number | null;
  format: "pct" | "money" | "num" | "raw";
  benchmark: number;
  /** lower-is-better ratios (COGS %, OpEx %) invert the grade math */
  inverse?: boolean;
  /** human-readable numerator/denominator, e.g. "$6.2M / $24.8M" */
  calc: string;
  /** when the inputs don't exist (no balance sheet, no headcount) */
  noData?: boolean;
  noDataMsg?: string;
  /** 0–100 sub-score used by the health gauge (null ratios don't count) */
  score: number | null;
  grade: Grade | null;
}

export interface CategoryScore {
  key: RatioCategory;
  score: number; // 0–100
}

export interface FinancialHealth {
  period: { from: string; to: string; label: string; months: number };
  hasBalanceSheet: boolean;
  hasDA: boolean;
  hasHeadcount: boolean;
  /** raw figures, for tooltips / drill context */
  figures: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    opex: number;
    operatingIncome: number;
    otherIncome: number;
    otherExpense: number;
    netIncome: number;
    depreciationAmortization: number;
    ebitda: number;
    totalAssets: number;
    totalEquity: number;
    totalDebt: number;
    investedCapital: number;
    headcount: number;
    revenueGrowth: number; // decimal
    operatingLeverage: number; // x
    rule40: number;
    breakevenMonthly: number | null;
  };
  ratios: Record<RatioCategory, RatioResult[]>;
  categoryScores: CategoryScore[];
  overallScore: number; // 0–100
  scoreLabel: string;
}

/** Ratio reference copy — surfaced in the click-through detail popover. */
export const RATIO_DEFS: Record<
  string,
  { label: string; formula: string; desc: string; interpret: string }
> = {
  gross_margin: {
    label: "Gross Margin",
    formula: "Gross Profit / Revenue",
    desc: "Share of revenue left after the direct cost of delivery.",
    interpret: "Higher is better. Services firms typically target 35–50%.",
  },
  operating_margin: {
    label: "Operating Margin",
    formula: "Operating Income / Revenue",
    desc: "Profitability from core operations, before interest and non-operating items.",
    interpret: "Above 15% is strong for most operating businesses.",
  },
  ebitda_margin: {
    label: "EBITDA Margin",
    formula: "(Operating Income + Depreciation + Amortization) / Revenue",
    desc: "Operating profitability before non-cash charges and financing.",
    interpret: "Above 20% is healthy; useful for comparing capital structures.",
  },
  net_margin: {
    label: "Net Profit Margin",
    formula: "Net Income / Revenue",
    desc: "Bottom-line profit as a share of revenue, after everything.",
    interpret: "Above 10% is healthy for most industries.",
  },
  roa: {
    label: "Return on Assets",
    formula: "Net Income / Total Assets",
    desc: "How efficiently the asset base generates profit.",
    interpret: "Above 8% indicates efficient asset use.",
  },
  roe: {
    label: "Return on Equity",
    formula: "Net Income / Total Equity",
    desc: "Return generated on shareholders' equity.",
    interpret: "Above 15% is generally considered strong.",
  },
  roic: {
    label: "Return on Invested Capital",
    formula: "NOPAT / Invested Capital",
    desc: "Return on all capital invested. NOPAT = Operating Income × (1 − 25% assumed tax). Invested Capital = Equity + Long-term Debt.",
    interpret: "Above your cost of capital (typically 8–12%) creates value.",
  },
  roce: {
    label: "Return on Capital Employed",
    formula: "Operating Income / Invested Capital",
    desc: "Pre-tax operating return on capital employed.",
    interpret: "Above 15% signals efficient capital deployment.",
  },
  rev_per_employee: {
    label: "Revenue per Employee",
    formula: "Revenue / Headcount",
    desc: "Top-line productivity of the workforce.",
    interpret: "Benchmarks vary materially by industry, geography, and reporting currency.",
  },
  gp_per_employee: {
    label: "Gross Profit per Employee",
    formula: "Gross Profit / Headcount",
    desc: "Value each employee contributes after direct costs.",
    interpret: "A cleaner productivity signal than revenue per head.",
  },
  asset_turnover: {
    label: "Asset Turnover",
    formula: "Revenue / Total Assets",
    desc: "Revenue generated per dollar of assets.",
    interpret: "Above 1.0x means assets turn over faster than once a year.",
  },
  cogs_ratio: {
    label: "COGS Ratio",
    formula: "COGS / Revenue",
    desc: "Direct cost of delivery as a share of revenue. Lower is better.",
    interpret: "The inverse of gross margin — keep it below your target.",
  },
  opex_ratio: {
    label: "OpEx Ratio",
    formula: "Operating Expenses / Revenue",
    desc: "Overhead as a share of revenue. Lower is better.",
    interpret: "Controlling this is the lever between gross and operating margin.",
  },
  operating_leverage: {
    label: "Operating Leverage",
    formula: "Δ Operating Income % / Δ Revenue %",
    desc: "How much operating income moves for a given revenue change.",
    interpret: "Above 1.0x means profits scale faster than revenue.",
  },
  interest_coverage: {
    label: "Interest Coverage",
    formula: "Operating Income / Other Expense",
    desc: "How many times operating income covers non-operating (interest) expense.",
    interpret: "Above 5x is comfortable; below 1.5x is a red flag.",
  },
  rule_of_40: {
    label: "Rule of 40",
    formula: "Revenue Growth % + Operating Margin %",
    desc: "Balances growth against profitability in a single number.",
    interpret: "40 or above is excellent — trade growth for margin or vice versa.",
  },
};

function grade(value: number | null, benchmark: number, inverse?: boolean): Grade | null {
  if (value === null || !isFinite(value)) return null;
  const ratio = inverse ? benchmark / (Math.abs(value) || 1e-9) : value / benchmark;
  if (ratio >= 1.2) return "A";
  if (ratio >= 1.0) return "B";
  if (ratio >= 0.8) return "C";
  if (ratio >= 0.6) return "D";
  return "F";
}

function scoreOf(value: number | null, benchmark: number, inverse?: boolean): number | null {
  if (value === null || !isFinite(value)) return null;
  const ratio = inverse ? benchmark / (Math.abs(value) || 1e-9) : value / benchmark;
  return Math.min(100, Math.max(0, ratio * 100));
}

/** Sum reader-signed statement rows of the given types at the top level. */
function totalOf(items: StatementRow[], types: string[]): ExactDecimal {
  return decimalSum(items
    .filter((r) => types.includes(r.type) && r.depth === 0)
    .map((row) => row.balance));
}

/** Shift an ISO date back one year (prior-year comparison period). */
function priorYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y! - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthsBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z");
  const b = new Date(to + "T00:00:00Z");
  const days = (b.getTime() - a.getTime()) / 86_400_000 + 1;
  return Math.max(1, days / 30.4375);
}

async function depreciationAmortization(orgId: string, from: string, to: string): Promise<number> {
  const r = ((await db.execute(sql`
    select coalesce(sum(l.amount), 0) as s
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId}
       and a.type in ('expense', 'expense_other', 'expense_deferred')
       and (lower(a.name) like '%deprec%' or lower(a.name) like '%amort%')
       and e.posting_date >= ${from} and e.posting_date <= ${to}
  `)));
  // expense accounts are debit-positive → already the D&A magnitude
  return Number(r.rows[0]?.s ?? 0);
}

async function activeHeadcount(orgId: string): Promise<number> {
  const r = ((await db.execute(sql`
    select count(*)::int as c from employee_roles where org_id = ${orgId} and terminated_on is null
  `)));
  return Number(r.rows[0]?.c ?? 0);
}

export async function financialHealth(
  period: {
    from: string;
    to: string;
    label: string;
  },
  benchmarks: HealthBenchmarks = DEFAULT_BENCHMARKS,
  orgId?: string,
): Promise<FinancialHealth> {
  const { moneyCompact } = await getMoneyFormatter(orgId)
  const resolvedOrgId = await resolveOrgId(orgId);
  const { from, to, label } = period;
  const b = benchmarks;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);

  const [pl, priorPl, bs, da, headcount] = await Promise.all([
    profitAndLoss(from, to, undefined, resolvedOrgId),
    profitAndLoss(pFrom, pTo, undefined, resolvedOrgId),
    balanceSheet(to, resolvedOrgId),
    depreciationAmortization(resolvedOrgId, from, to),
    activeHeadcount(resolvedOrgId),
  ]);

  // Operating vs non-operating split, straight off account types.
  // Ratios are presentation analytics. All source rollups above remain exact;
  // convert each final monetary input once before ratio math.
  const operatingRevenue = Number(totalOf(pl.items, ["income"]));
  const otherIncome = Number(totalOf(pl.items, ["income_other"]));
  const revenue = Number(pl.revenue); // = operatingRevenue + otherIncome (ties to P&L report)
  const cogs = Number(pl.cogs);
  const grossProfit = Number(pl.grossProfit);
  const opex = Number(totalOf(pl.items, ["expense", "expense_deferred"]));
  const otherExpense = Number(totalOf(pl.items, ["expense_other"]));
  const operatingIncome = operatingRevenue - cogs - opex;
  const netIncome = Number(pl.netIncome); // = revenue - cogs - opex - otherExpense

  const priorRevenue = Number(priorPl.revenue);
  const priorOperatingRevenue = Number(totalOf(priorPl.items, ["income"]));
  const priorOpInc = priorOperatingRevenue - Number(priorPl.cogs) - Number(totalOf(priorPl.items, ["expense", "expense_deferred"]));
  const revenueGrowth = priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue : 0;
  const opIncGrowth = priorOpInc !== 0 ? (operatingIncome - priorOpInc) / Math.abs(priorOpInc) : 0;
  const operatingLeverage = revenueGrowth !== 0 ? opIncGrowth / revenueGrowth : 1;

  // Balance sheet
  const totalAssets = Number(bs.totalAssets);
  const totalEquity = Number(bs.totalEquity);
  const totalDebt = Number(totalOf(bs.liabilities, ["liability_long_term"]));
  const investedCapital = totalEquity + totalDebt;
  const hasBalanceSheet = Math.abs(totalAssets) > 0;

  // Derived
  const ebitda = operatingIncome + da;
  const hasDA = Math.abs(da) > 0;
  const hasHeadcount = headcount > 0;
  const nopat = operatingIncome * 0.75;
  const ebitdaMargin = revenue > 0 ? ebitda / revenue : 0;
  const operatingMargin = revenue > 0 ? operatingIncome / revenue : 0;
  const rule40 = revenueGrowth * 100 + operatingMargin * 100;

  const roa = hasBalanceSheet && totalAssets > 0 ? netIncome / totalAssets : null;
  const roe = hasBalanceSheet && Math.abs(totalEquity) > 0 ? netIncome / totalEquity : null;
  const roic = hasBalanceSheet && investedCapital > 0 ? nopat / investedCapital : null;
  const roce = hasBalanceSheet && investedCapital > 0 ? operatingIncome / investedCapital : null;
  const assetTurnover = hasBalanceSheet && totalAssets > 0 ? revenue / totalAssets : null;

  const months = monthsBetween(from, to);
  const grossMarginPct = revenue > 0 ? grossProfit / revenue : 0;
  // Monthly revenue needed to cover fixed costs (opex) at the target gross
  // margin. the chooseTargetGMPct: use actual range GM when it's above 5%,
  // else fall back to a 20% planning default; clamp to 5–60% so distressed or
  // windfall margins don't produce absurd breakevens.
  const targetGM = Math.min(0.6, Math.max(0.05, grossMarginPct > 0.05 ? grossMarginPct : 0.2));
  const breakevenMonthly = opex > 0 ? opex / months / targetGM : null;

  const M = (n: number) => moneyCompact(n);

  // ---- Ratio grids ---------------------------------------------------------
  const profitability: RatioResult[] = [
    mk("gross_margin", grossMarginPct, "pct", b.grossMargin, false, `${M(grossProfit)} / ${M(revenue)}`),
    mk("operating_margin", operatingMargin, "pct", b.operatingMargin, false, `${M(operatingIncome)} / ${M(revenue)}`),
    mk("ebitda_margin", ebitdaMargin, "pct", b.ebitdaMargin, false, `${M(ebitda)} / ${M(revenue)}`, !hasDA, "No depreciation/amortization accounts found"),
    mk("net_margin", revenue > 0 ? netIncome / revenue : 0, "pct", b.netMargin, false, `${M(netIncome)} / ${M(revenue)}`),
    mk("roa", roa, "pct", b.roa, false, roa !== null ? `${M(netIncome)} / ${M(totalAssets)}` : "N/A", !hasBalanceSheet, "No balance sheet data"),
    mk("roe", roe, "pct", b.roe, false, roe !== null ? `${M(netIncome)} / ${M(totalEquity)}` : "N/A", !hasBalanceSheet, "No balance sheet data"),
    mk("roic", roic, "pct", b.roic, false, roic !== null ? `${M(nopat)} (NOPAT) / ${M(investedCapital)}` : "N/A", !hasBalanceSheet, "No balance sheet data"),
    mk("roce", roce, "pct", 0.15, false, roce !== null ? `${M(operatingIncome)} / ${M(investedCapital)}` : "N/A", !hasBalanceSheet, "No balance sheet data"),
  ];

  const efficiency: RatioResult[] = [
    mk("rev_per_employee", hasHeadcount ? revenue / headcount : null, "money", b.revenuePerEmployee, false, hasHeadcount ? `${M(revenue)} / ${headcount} employees` : "N/A", !hasHeadcount, "No active employee records"),
    mk("gp_per_employee", hasHeadcount ? grossProfit / headcount : null, "money", b.gpPerEmployee, false, hasHeadcount ? `${M(grossProfit)} / ${headcount} employees` : "N/A", !hasHeadcount, "No active employee records"),
    mk("asset_turnover", assetTurnover, "num", 1.0, false, assetTurnover !== null ? `${M(revenue)} / ${M(totalAssets)}` : "N/A", !hasBalanceSheet, "No balance sheet data"),
  ];

  const operating: RatioResult[] = [
    mk("cogs_ratio", revenue > 0 ? cogs / revenue : 0, "pct", 0.6, true, `${M(cogs)} / ${M(revenue)}`),
    mk("opex_ratio", revenue > 0 ? opex / revenue : 0, "pct", 0.25, true, `${M(opex)} / ${M(revenue)}`),
    mk("operating_leverage", operatingLeverage, "num", 1.5, false, `${fmtPct(opIncGrowth)} / ${fmtPct(revenueGrowth)}`),
    mk("interest_coverage", otherExpense > 0 ? operatingIncome / otherExpense : 99, "num", 5.0, false, otherExpense > 0 ? `${M(operatingIncome)} / ${M(otherExpense)}` : "No interest expense"),
    mk("rule_of_40", rule40, "raw", 40, false, `${fmtPct(revenueGrowth)} + ${fmtPct(operatingMargin)}`),
  ];

  const ratios: Record<RatioCategory, RatioResult[]> = { profitability, efficiency, operating };

  // ---- Health score --------------------------------------------------------
  const catScore = (rs: RatioResult[]): number => {
    const scored = rs.map((r) => r.score).filter((s): s is number => s !== null);
    return scored.length ? scored.reduce((a, s) => a + s, 0) / scored.length : 0;
  };
  const categoryScores: CategoryScore[] = [
    { key: "profitability", score: catScore(profitability) },
    { key: "efficiency", score: catScore(efficiency) },
    { key: "operating", score: catScore(operating) },
  ];
  const present = categoryScores.filter((c) => c.score > 0);
  const overallScore = present.length ? present.reduce((a, c) => a + c.score, 0) / present.length : 0;
  const scoreLabel = overallScore >= 80 ? "excellent" : overallScore >= 60 ? "good" : overallScore >= 40 ? "average" : "needsWork";

  return {
    period: { from, to, label, months: Math.round(months) },
    hasBalanceSheet,
    hasDA,
    hasHeadcount,
    figures: {
      revenue, cogs, grossProfit, opex, operatingIncome, otherIncome, otherExpense,
      netIncome, depreciationAmortization: da, ebitda, totalAssets, totalEquity,
      totalDebt, investedCapital, headcount, revenueGrowth, operatingLeverage, rule40,
      breakevenMonthly,
    },
    ratios,
    categoryScores,
    overallScore,
    scoreLabel,
  };
}

function mk(
  id: string,
  value: number | null,
  format: RatioResult["format"],
  benchmark: number,
  inverse: boolean,
  calc: string,
  noData = false,
  noDataMsg?: string,
): RatioResult {
  const v = noData ? null : value;
  return {
    id,
    value: v,
    format,
    benchmark,
    inverse,
    calc,
    noData,
    noDataMsg,
    score: scoreOf(v, benchmark, inverse),
    grade: grade(v, benchmark, inverse),
  };
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}
