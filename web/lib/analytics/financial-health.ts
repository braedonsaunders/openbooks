import "server-only";
import { analyticsQuery } from "./query";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { profitAndLoss, balanceSheet, type StatementRow } from "../reports";
import { statementBookExpr } from "../gl-summary";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { resolveOrgId } from "../org-scope";
import { flowRates, presentationCurrency, presentationRates } from "../fx-presentation";
import { add, cmp, mulDecimal, mulRatio, neg } from "@openbooks/engine/money";
import { addCalendarDays, addMonthsClamped, inclusiveCalendarDays, calendarDaysBetween } from "@openbooks/engine/platform/civil-date";
import { enactedIncomeTaxRate } from "@openbooks/engine/tax-returns";
import { resolveAccountGroups } from "../account-groups";
import { defaultFiscalCalendarPeriods, fiscalYearStartOnDate } from "../fiscal";
import { healthStrings, type FinancialHealthNotes } from "./health-strings";
import { englishCatalogMessage } from "./catalog-strings";
import { OPERATING_EXPENSE_TYPES } from "./operating-expenses";
import { decimalSum, type ExactDecimal } from '../statement-format'
import { decimalRatio, decimalSubtract } from "../reports/decimals";
import { analyticsConfig } from "./config";
import { RATIO_CATEGORIES, type Grade, type RatioCategory, type RatioFormat, type RatioId } from "./ratio-ids";

/**
 * Financial Health — the ratio and scorecard engine behind
 * /analytics/financial-health, the Accounting home and the home-dashboard
 * ratio widgets.
 *
 * Every figure derives from the organization's own ledger through the same
 * statement readers as the P&L and Balance Sheet reports, translated into the
 * presentation currency whenever the scope holds any other functional
 * currency. Figures stay exact decimal strings; ratios are exact quotients.
 *
 * Nothing is assumed:
 * - every benchmark and every grading cut-off is organization configuration
 *   (Financial Health → Configuration);
 * - the tax rate behind NOPAT is the effective rate the books carry for the
 *   period, else the enacted statutory rate configured in tax setup, else the
 *   ratio is refused by name;
 * - interest expense and interest-bearing debt are the accounts the
 *   organization classifies in the `financial_ratios` account-group dimension;
 *   until it does, the ratios that need them say so;
 * - ratios that relate a period flow to a point-in-time balance are
 *   annualized over the length of the fiscal year containing the period end;
 * - a ratio whose inputs do not exist is null with the reason, never zero.
 */

export { RATIO_IDS, RATIO_CATEGORIES, type RatioId, type RatioCategory, type RatioFormat, type Grade } from "./ratio-ids";

/** The account-group dimension holding the organization's ratio classifications. */
export const RATIO_INPUT_DIMENSION = "financial_ratios";
export const RATIO_INPUT_KEYS = ["interest_expense", "interest_bearing_debt"] as const;
export type RatioInputKey = (typeof RATIO_INPUT_KEYS)[number];

/**
 * Grading policy and per-ratio targets, all from configuration. Targets are
 * exact decimals in the ratio's own unit (fractions for pct, multiples for
 * times, points for points, presentation-currency amounts for money); null
 * means the organization has not set one, so the ratio shows ungraded.
 */
export interface HealthBenchmarks {
  targets: Record<RatioId, ExactDecimal | null>;
  /** Achievement (value ÷ target, inverted for lower-is-better) needed for A, B, C and D. */
  grades: { a: ExactDecimal; b: ExactDecimal; c: ExactDecimal; d: ExactDecimal };
  /** Overall score needed for each label. */
  labels: { excellent: number; good: number; average: number };
}

export interface RatioResult {
  id: RatioId;
  category: RatioCategory;
  /** Exact value in the ratio's unit; null when the ratio cannot be computed (see `unavailable`). */
  value: ExactDecimal | null;
  format: RatioFormat;
  benchmark: ExactDecimal | null;
  /** Lower is better (cost and leverage ratios). */
  inverse: boolean;
  /** Human-readable numerator / denominator. */
  calc: string;
  /** How the figure was measured when that is a choice the reader must know (annualized, effective tax rate). */
  basis: string | null;
  /** Why there is no value, in the request language. */
  unavailable: string | null;
  /** 0–100 sub-score for the health gauge; null when ungraded. */
  score: number | null;
  grade: Grade | null;
}

export interface CategoryScore {
  key: RatioCategory;
  /** null when no ratio in the category could be graded. */
  score: number | null;
}

export type ScoreLabel = "excellent" | "good" | "average" | "needsWork";

export interface HealthFigures {
  revenue: ExactDecimal;
  operatingRevenue: ExactDecimal;
  otherIncome: ExactDecimal;
  cogs: ExactDecimal;
  grossProfit: ExactDecimal;
  /** Operating expenses, excluding income tax however the chart classifies it. */
  opex: ExactDecimal;
  operatingIncome: ExactDecimal;
  otherExpense: ExactDecimal;
  /** Null when no income tax expense account is designated. */
  incomeTaxExpense: ExactDecimal | null;
  netIncome: ExactDecimal;
  preTaxIncome: ExactDecimal;
  depreciationAmortization: ExactDecimal;
  ebitda: ExactDecimal | null;
  totalAssets: ExactDecimal;
  currentAssets: ExactDecimal;
  quickAssets: ExactDecimal;
  totalLiabilities: ExactDecimal;
  currentLiabilities: ExactDecimal;
  totalEquity: ExactDecimal;
  workingCapital: ExactDecimal;
  /** Total assets − current liabilities. */
  capitalEmployed: ExactDecimal;
  /** Null until the organization classifies its interest-bearing debt. */
  interestBearingDebt: ExactDecimal | null;
  interestExpense: ExactDecimal | null;
  investedCapital: ExactDecimal | null;
  priorRevenue: ExactDecimal;
  priorOperatingIncome: ExactDecimal;
  /** Fractions; null without a positive prior comparison. */
  revenueGrowth: ExactDecimal | null;
  operatingLeverage: ExactDecimal | null;
  rule40: ExactDecimal | null;
  /** Revenue the period needed to cover its operating expenses at its gross margin; null without a positive margin. */
  breakevenRevenue: ExactDecimal | null;
  headcount: number;
}

export type HealthPnlFigures = Pick<HealthFigures, 'revenue' | 'cogs' | 'grossProfit' | 'opex' | 'operatingIncome' | 'otherExpense' | 'netIncome'>;

export interface FinancialHealth {
  period: { from: string; to: string; label: string; days: number; fiscalYearDays: number };
  prior: { from: string; to: string };
  currency: string;
  hasBalanceSheet: boolean;
  figures: HealthFigures;
  /** Prior comparison from the same statement read; no second health evaluation. */
  priorFigures: HealthPnlFigures;
  ratios: Record<RatioCategory, RatioResult[]>;
  categoryScores: CategoryScore[];
  /** null when nothing could be graded. */
  overallScore: number | null;
  scoreLabel: ScoreLabel | null;
  benchmarks: HealthBenchmarks;
  /** Which classifications the organization has made (drives the Configuration panel and refusals). */
  ratioInputs: Record<RatioInputKey, string[] | null>;
}

const ZERO = "0.0000";
const CURRENT_ASSET_TYPES = ["asset_bank", "asset_receivable", "asset_current_other"];
const QUICK_ASSET_TYPES = ["asset_bank", "asset_receivable"];
const CURRENT_LIABILITY_TYPES = ["liability_payable", "liability_card", "liability_current_other"];

/** Sum reader-signed statement rows of the given types. Each account prints
 * once at its own balance (gross presentation), so the total sums every row. */
function totalOf(items: StatementRow[], types: string[]): ExactDecimal {
  return decimalSum(items.filter((r) => types.includes(r.type)).map((row) => row.balance));
}

const isPositive = (v: ExactDecimal) => cmp(v, ZERO) > 0;

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

const pctTarget = (v: number) => decimalRatio(String(v), "100");

/** Per-org targets and grading policy (percent-scale in the store → fractions here). */
export async function healthBenchmarks(orgId: string): Promise<HealthBenchmarks> {
  const c = await analyticsConfig(orgId, "financialHealth");
  const money = (v: string) => (v === "" ? null : v);
  return {
    targets: {
      gross_margin: pctTarget(c.grossMarginTarget),
      operating_margin: pctTarget(c.operatingMarginTarget),
      ebitda_margin: pctTarget(c.ebitdaMarginTarget),
      net_margin: pctTarget(c.netMarginTarget),
      roa: pctTarget(c.roaTarget),
      roe: pctTarget(c.roeTarget),
      roic: pctTarget(c.roicTarget),
      roce: pctTarget(c.roceTarget),
      current_ratio: String(c.currentRatioTarget),
      quick_ratio: String(c.quickRatioTarget),
      working_capital: null,
      debt_to_equity: String(c.debtToEquityTarget),
      liabilities_to_equity: String(c.liabilitiesToEquityTarget),
      interest_coverage: String(c.interestCoverageTarget),
      rev_per_employee: money(c.revenuePerEmployee),
      gp_per_employee: money(c.gpPerEmployee),
      asset_turnover: String(c.assetTurnoverTarget),
      cogs_ratio: pctTarget(c.cogsRatioTarget),
      opex_ratio: pctTarget(c.opexRatioTarget),
      operating_leverage: String(c.operatingLeverageTarget),
      rule_of_40: String(c.ruleOf40Target),
    },
    grades: {
      a: pctTarget(c.gradeAPercent)!,
      b: pctTarget(c.gradeBPercent)!,
      c: pctTarget(c.gradeCPercent)!,
      d: pctTarget(c.gradeDPercent)!,
    },
    labels: { excellent: c.scoreExcellent, good: c.scoreGood, average: c.scoreAverage },
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/** Value ÷ target (target ÷ value when lower is better), or null when not gradeable. */
function achievement(value: ExactDecimal, target: ExactDecimal, inverse: boolean): ExactDecimal | null {
  if (!isPositive(target)) return null;
  if (!inverse) return decimalRatio(value, target);
  // Lower is better: nothing at all is the best possible result.
  if (!isPositive(value)) return "100.0000";
  return decimalRatio(target, value);
}

function gradeOf(ach: ExactDecimal, b: HealthBenchmarks): Grade {
  if (cmp(ach, b.grades.a) >= 0) return "A";
  if (cmp(ach, b.grades.b) >= 0) return "B";
  if (cmp(ach, b.grades.c) >= 0) return "C";
  if (cmp(ach, b.grades.d) >= 0) return "D";
  return "F";
}

/** 0–100, presentation-only: the comparison above stays exact. */
function scoreOf(ach: ExactDecimal): number {
  const pct = Number(mulDecimal(ach, "100"));
  return Math.min(100, Math.max(0, pct));
}

export function scoreLabelOf(score: number | null, b: HealthBenchmarks): ScoreLabel | null {
  if (score === null) return null;
  if (score >= b.labels.excellent) return "excellent";
  if (score >= b.labels.good) return "good";
  if (score >= b.labels.average) return "average";
  return "needsWork";
}

// ---------------------------------------------------------------------------
// Ledger inputs
// ---------------------------------------------------------------------------

/** Translated period activity (debit-positive) on the given accounts. */
async function accountActivity(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null, accountIds: string[]): Promise<ExactDecimal> {
  if (accountIds.length === 0) return ZERO;
  const r = await analyticsQuery<{ func: string | null; s: string; late: string | null }>(sql`
    select sub.base_currency as func, coalesce(sum(l.amount), 0)::text as s, max(e.posting_date)::text as late
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.account_id = any(${`{${accountIds.join(",")}}`}::uuid[])
       and e.status in ('posted', 'reversed')
       and e.book_id = ${statementBookExpr(orgId)}
       and e.posting_date >= ${from} and e.posting_date <= ${to}
       ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
     group by sub.base_currency
  `);
  // Each functional leg translates at its latest posting date in the window.
  const ctx = await flowRates(orgId, r.rows.map((leg) => ({ func: leg.func ?? null, date: (leg.late ?? to).slice(0, 10) })));
  return decimalSum(r.rows.map((leg) => mulDecimal(leg.s, ctx.rateAt(leg.func ?? null, (leg.late ?? to).slice(0, 10)))));
}

/** Translated closing balance (credit-positive) on the given accounts as of a date, at the closing spot rate. */
async function creditBalance(orgId: string, asOf: string, allowed: ReadonlySet<string> | null, accountIds: string[]): Promise<ExactDecimal> {
  if (accountIds.length === 0) return ZERO;
  const r = await analyticsQuery<{ func: string | null; s: string }>(sql`
    select sub.base_currency as func, coalesce(-sum(l.amount), 0)::text as s
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.account_id = any(${`{${accountIds.join(",")}}`}::uuid[])
       and e.status in ('posted', 'reversed')
       and e.book_id = ${statementBookExpr(orgId)}
       and e.posting_date <= ${asOf}
       ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
     group by sub.base_currency
  `);
  if (r.rows.length === 0) return ZERO;
  const base = await presentationCurrency(orgId);
  const rates = await presentationRates(orgId, base, r.rows.map((row) => row.func), asOf);
  return decimalSum(r.rows.map((row) => mulDecimal(row.s, rates.get(row.func ?? base) ?? "1")));
}

async function depreciationAmortization(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null): Promise<ExactDecimal> {
  const r = await analyticsQuery<{ func: string | null; s: string; late: string | null }>(sql`
    with da_accounts as (
      -- These account references are the authoritative D&A classification. They
      -- remain correct when a tenant names its chart in any language.
      select c.depreciation_expense_account_id as account_id
        from asset_categories c
       where c.org_id = ${orgId}
      union
      select coalesce(a.depreciation_expense_account_id, c.depreciation_expense_account_id) as account_id
        from fixed_assets a
        join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
       where a.org_id = ${orgId}
      union
      select l.amortization_expense_account_id as account_id
        from lease_agreements l
       where l.org_id = ${orgId}
    )
    select sub.base_currency as func, coalesce(sum(l.amount), 0)::text as s,
      max(e.posting_date)::text as late
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
     where l.org_id = ${orgId}
       and a.type in ('expense', 'expense_other', 'expense_deferred')
       and e.status in ('posted', 'reversed')
       and e.book_id = ${statementBookExpr(orgId)}
       ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
       and (e.origin = 'depreciation' or exists (
         select 1 from da_accounts d where d.account_id = a.id
       ))
       and e.posting_date >= ${from} and e.posting_date <= ${to}
     group by sub.base_currency
  `);
  // Expense accounts are debit-positive, already the D&A magnitude; each
  // functional leg translates at its latest posting date.
  const ctx = await flowRates(orgId, r.rows.map((leg) => ({ func: leg.func ?? null, date: (leg.late ?? to).slice(0, 10) })));
  return decimalSum(r.rows.map((leg) => mulDecimal(leg.s, ctx.rateAt(leg.func ?? null, (leg.late ?? to).slice(0, 10)))));
}

// Employment dates govern the selected period, including an employee
// through their final employment day. Undated legacy hires remain eligible.
async function activeHeadcount(orgId: string, asOf: string, allowed: ReadonlySet<string> | null): Promise<number> {
  const r = await analyticsQuery<{ c: number }>(sql`
    select count(*)::int as c from employee_roles er
    join parties p on p.id = er.party_id and p.org_id = er.org_id
    where er.org_id = ${orgId}
      and (er.hired_on is null or er.hired_on <= ${asOf})
      and (er.terminated_on is null or er.terminated_on >= ${asOf})
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed)}
  `);
  return Number(r.rows[0]?.c ?? 0);
}

/** In-scope legal entities: the visible subsidiaries (or every one) plus the root. */
async function scopeEntities(orgId: string, allowed: ReadonlySet<string> | null): Promise<{ id: string | null; currency: string; controlTaxAccount: string | null }[]> {
  const r = await analyticsQuery<{ id: string; currency: string; tax: string | null }>(sql`
    select s.id, s.base_currency as currency, s.control_accounts ->> 'incomeTaxExpense' as tax
      from subsidiaries s
     where s.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`s.id`, allowed)}
  `);
  const org = await analyticsQuery<{ currency: string; tax: string | null }>(sql`
    select base_currency as currency, settings -> 'controlAccounts' ->> 'incomeTaxExpense' as tax from orgs where id = ${orgId}
  `);
  const root = org.rows[0];
  const subs = r.rows.map((s) => ({ id: s.id, currency: s.currency, controlTaxAccount: s.tax ?? root?.tax ?? null }));
  return allowed === null && root ? [{ id: null, currency: root.currency, controlTaxAccount: root.tax }, ...subs] : subs;
}

/** The same window one fiscal year earlier, on the organization's calendar. */
export async function priorFiscalWindow(orgId: string, from: string, to: string): Promise<{ from: string; to: string }> {
  const declared = await defaultFiscalCalendarPeriods(orgId);
  if (!declared || declared.cadence === "monthly") {
    return { from: addMonthsClamped(from, -12), to: addMonthsClamped(to, -12) };
  }
  // Week-based calendars: the prior year is the previous fiscal year's length earlier.
  const yearStart = await fiscalYearStartOnDate(from, orgId);
  const priorStart = await fiscalYearStartOnDate(addCalendarDays(yearStart, -1), orgId);
  const offset = calendarDaysBetween(priorStart, yearStart);
  return { from: addCalendarDays(from, -offset), to: addCalendarDays(to, -offset) };
}

/** Days in the fiscal year containing `asOf`, on the organization's calendar. */
async function fiscalYearDays(orgId: string, asOf: string): Promise<number> {
  const start = await fiscalYearStartOnDate(asOf, orgId);
  // 371 days lands inside the next fiscal year for every calendar shape (a
  // 53-week year is 371 days; a month-based year at most 366).
  const nextStart = await fiscalYearStartOnDate(addCalendarDays(start, 371), orgId);
  return calendarDaysBetween(start, nextStart);
}

interface Statements {
  pl: { items: StatementRow[]; revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; netIncome: ExactDecimal };
  priorPl: { items: StatementRow[]; revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; netIncome: ExactDecimal };
  bs: { assets: StatementRow[]; liabilities: StatementRow[]; totalAssets: ExactDecimal; totalLiabilities: ExactDecimal; totalEquity: ExactDecimal };
}

/**
 * The period's statements in the presentation currency. A scope whose every
 * entity reports in the presentation currency reads the native statement
 * readers (figures tie to the reports line for line); any other scope —
 * several functional currencies, or one that is not the presentation
 * currency — translates through the statement matrix exactly as the
 * consolidated statements do.
 */
async function presentationStatements(
  orgId: string, from: string, to: string, prior: { from: string; to: string },
  allowed: ReadonlySet<string> | null, entities: { currency: string }[], currency: string,
): Promise<Statements> {
  const dims = allowed === null ? undefined : { subsidiaryIds: [...allowed] };
  if (entities.every((e) => e.currency === currency)) {
    const [pl, priorPl, bs] = await Promise.all([
      profitAndLoss(from, to, dims, orgId),
      profitAndLoss(prior.from, prior.to, dims, orgId),
      balanceSheet(to, orgId, undefined, dims),
    ]);
    return { pl, priorPl, bs };
  }
  // Loaded dynamically: the consolidation chain pulls Next-server modules
  // that the unit-test loader graphs must never see on the hot path.
  const { translatedHealthStatements } = await import("./health-translated-statements");
  return translatedHealthStatements(orgId, from, to, prior.from, prior.to, dims, allowed);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export async function financialHealth(
  period: { from: string; to: string; label: string },
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  notes: FinancialHealthNotes = healthStrings(englishCatalogMessage, "en"),
): Promise<FinancialHealth> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const { moneyCompact } = await getMoneyFormatter(resolvedOrgId);
  const { from, to, label } = period;
  const allowed = allowedSubsidiaryIds;

  const [benchmarks, currency, entities, prior, yearDays, groups] = await Promise.all([
    healthBenchmarks(resolvedOrgId),
    presentationCurrency(resolvedOrgId),
    scopeEntities(resolvedOrgId, allowed),
    priorFiscalWindow(resolvedOrgId, from, to),
    fiscalYearDays(resolvedOrgId, to),
    resolveAccountGroups(RATIO_INPUT_DIMENSION, resolvedOrgId),
  ]);

  // Classifications the organization made. A group that exists with no
  // accounts is a decision ("we carry no debt"); a missing group is not.
  const ratioInputs = Object.fromEntries(RATIO_INPUT_KEYS.map((key) => {
    const group = groups.groups.find((g) => g.key === key);
    if (!group) return [key, null];
    const ids = [...groups.byAccount.entries()].filter(([, ref]) => ref.key === key).map(([id]) => id);
    return [key, ids];
  })) as Record<RatioInputKey, string[] | null>;
  const taxAccounts = [...new Set(entities.map((e) => e.controlTaxAccount).filter((id): id is string => !!id))];

  const [st, da, headcount, taxExpense, interestExpense, debt] = await Promise.all([
    presentationStatements(resolvedOrgId, from, to, prior, allowed, entities, currency),
    depreciationAmortization(resolvedOrgId, from, to, allowed),
    activeHeadcount(resolvedOrgId, to, allowed),
    taxAccounts.length > 0 ? accountActivity(resolvedOrgId, from, to, allowed, taxAccounts) : Promise.resolve(null),
    ratioInputs.interest_expense ? accountActivity(resolvedOrgId, from, to, allowed, ratioInputs.interest_expense) : Promise.resolve(null),
    ratioInputs.interest_bearing_debt ? creditBalance(resolvedOrgId, to, allowed, ratioInputs.interest_bearing_debt) : Promise.resolve(null),
  ]);
  const { pl, priorPl, bs } = st;

  // Income tax booked to an operating expense account is still tax: it never
  // reduces operating income, so NOPAT taxes the profit once.
  const taxInOpex = taxAccounts.length > 0
    ? await accountActivityOfTypes(resolvedOrgId, from, to, allowed, taxAccounts, [...OPERATING_EXPENSE_TYPES])
    : ZERO;
  const priorTaxInOpex = taxAccounts.length > 0
    ? await accountActivityOfTypes(resolvedOrgId, prior.from, prior.to, allowed, taxAccounts, [...OPERATING_EXPENSE_TYPES])
    : ZERO;

  const operatingRevenue = totalOf(pl.items, ["income"]);
  const otherIncome = totalOf(pl.items, ["income_other"]);
  const revenue = pl.revenue;
  const cogs = pl.cogs;
  const grossProfit = pl.grossProfit;
  const opex = decimalSubtract(totalOf(pl.items, [...OPERATING_EXPENSE_TYPES]), taxInOpex);
  const otherExpense = totalOf(pl.items, ["expense_other"]);
  const operatingIncome = decimalSum([operatingRevenue, neg(cogs), neg(opex)]);
  const netIncome = pl.netIncome;
  const preTaxIncome = add(netIncome, taxExpense ?? ZERO);

  const priorRevenue = priorPl.revenue;
  const priorOperatingIncome = decimalSum([
    totalOf(priorPl.items, ["income"]),
    neg(priorPl.cogs),
    neg(decimalSubtract(totalOf(priorPl.items, [...OPERATING_EXPENSE_TYPES]), priorTaxInOpex)),
  ]);

  const totalAssets = bs.totalAssets;
  const totalEquity = bs.totalEquity;
  const totalLiabilities = bs.totalLiabilities;
  const currentAssets = totalOf(bs.assets, CURRENT_ASSET_TYPES);
  const quickAssets = totalOf(bs.assets, QUICK_ASSET_TYPES);
  const fixedAssets = totalOf(bs.assets, ["asset_fixed"]);
  const currentLiabilities = totalOf(bs.liabilities, CURRENT_LIABILITY_TYPES);
  const hasBalanceSheet = cmp(totalAssets, ZERO) !== 0;
  const workingCapital = decimalSubtract(currentAssets, currentLiabilities);
  const capitalEmployed = decimalSubtract(totalAssets, currentLiabilities);
  const investedCapital = debt === null ? null : add(totalEquity, debt);

  // D&A of zero is a fact when the balance sheet carries no fixed assets; with
  // fixed assets on the books and no depreciation found, EBITDA is unknown.
  const ebitda = cmp(da, ZERO) === 0 && cmp(fixedAssets, ZERO) !== 0 ? null : add(operatingIncome, da);

  const revenueGrowth = isPositive(priorRevenue) ? decimalRatio(decimalSubtract(revenue, priorRevenue), priorRevenue) : null;
  const opIncGrowth = cmp(priorOperatingIncome, ZERO) !== 0
    ? decimalRatio(decimalSubtract(operatingIncome, priorOperatingIncome), priorOperatingIncome.startsWith("-") ? neg(priorOperatingIncome) : priorOperatingIncome)
    : null;
  const operatingLeverage = revenueGrowth !== null && opIncGrowth !== null && cmp(revenueGrowth, ZERO) !== 0
    ? decimalRatio(opIncGrowth, revenueGrowth)
    : null;
  const operatingMargin = isPositive(revenue) ? decimalRatio(operatingIncome, revenue) : null;
  const rule40 = revenueGrowth !== null && operatingMargin !== null
    ? mulDecimal(add(revenueGrowth, operatingMargin), "100")
    : null;
  const grossMargin = isPositive(revenue) ? decimalRatio(grossProfit, revenue) : null;
  const breakevenRevenue = grossMargin !== null && isPositive(grossMargin) ? decimalRatio(opex, grossMargin) : null;

  // Flow-over-balance ratios are annualized over the fiscal year containing
  // the period end, so a month and a year grade against the same target.
  const periodDays = inclusiveCalendarDays(from, to);
  const annualize = (flow: ExactDecimal): ExactDecimal => mulRatio(flow, BigInt(yearDays), BigInt(periodDays));
  const annualBasis = periodDays === yearDays ? null : notes.annualized(periodDays, yearDays);

  // NOPAT's tax rate: effective (booked) first, enacted statutory second.
  const taxRate = await nopatTaxRate(resolvedOrgId, to, entities, taxExpense, preTaxIncome);

  const M = (n: ExactDecimal) => moneyCompact(n);
  const T = benchmarks.targets;

  const mk = (
    id: RatioId,
    category: RatioCategory,
    format: RatioFormat,
    inverse: boolean,
    computed: { value: ExactDecimal | null; calc: string; basis?: string | null; unavailable?: string | null },
  ): RatioResult => {
    const value = computed.unavailable ? null : computed.value;
    const unavailable = value === null ? (computed.unavailable ?? notes.unavailable) : null;
    const benchmark = T[id];
    const ach = value !== null && benchmark !== null ? achievement(value, benchmark, inverse) : null;
    return {
      id, category, value, format, benchmark, inverse,
      calc: computed.calc,
      basis: computed.basis ?? null,
      unavailable,
      score: ach === null ? null : scoreOf(ach),
      grade: ach === null ? null : gradeOf(ach, benchmarks),
    };
  };
  const ofRevenue = (n: ExactDecimal) => (isPositive(revenue)
    ? { value: decimalRatio(n, revenue), calc: `${M(n)} / ${M(revenue)}` }
    : { value: null, calc: "", unavailable: notes.noRevenue });
  const needsBalanceSheet = { value: null, calc: "", unavailable: notes.noBalanceSheet };
  const overEquity = (n: ExactDecimal, calcN: string) => (!hasBalanceSheet
    ? needsBalanceSheet
    : !isPositive(totalEquity)
      ? { value: null, calc: "", unavailable: notes.equityNotPositive }
      : { value: decimalRatio(n, totalEquity), calc: `${calcN} / ${M(totalEquity)}` });

  const profitability: RatioResult[] = [
    mk("gross_margin", "profitability", "pct", false, ofRevenue(grossProfit)),
    mk("operating_margin", "profitability", "pct", false, ofRevenue(operatingIncome)),
    mk("ebitda_margin", "profitability", "pct", false, ebitda === null ? { value: null, calc: "", unavailable: notes.noDA } : ofRevenue(ebitda)),
    mk("net_margin", "profitability", "pct", false, ofRevenue(netIncome)),
    mk("roa", "profitability", "pct", false, !hasBalanceSheet || !isPositive(totalAssets)
      ? needsBalanceSheet
      : { value: decimalRatio(annualize(netIncome), totalAssets), calc: `${M(annualize(netIncome))} / ${M(totalAssets)}`, basis: annualBasis }),
    mk("roe", "profitability", "pct", false, { ...overEquity(annualize(netIncome), M(annualize(netIncome))), basis: annualBasis }),
    mk("roic", "profitability", "pct", false, !hasBalanceSheet
      ? needsBalanceSheet
      : investedCapital === null
        ? { value: null, calc: "", unavailable: notes.debtNotClassified }
        : !isPositive(investedCapital)
          ? { value: null, calc: "", unavailable: notes.investedCapitalNotPositive }
          : !taxRate.rate
            ? { value: null, calc: "", unavailable: taxRate.reason }
            : (() => {
                const nopat = mulDecimal(annualize(operatingIncome), decimalSubtract("1", taxRate.rate));
                return {
                  value: decimalRatio(nopat, investedCapital),
                  calc: `${M(nopat)} / ${M(investedCapital)}`,
                  basis: [taxRate.basis, annualBasis].filter(Boolean).join(" · "),
                };
              })()),
    mk("roce", "profitability", "pct", false, !hasBalanceSheet || !isPositive(capitalEmployed)
      ? needsBalanceSheet
      : { value: decimalRatio(annualize(operatingIncome), capitalEmployed), calc: `${M(annualize(operatingIncome))} / ${M(capitalEmployed)}`, basis: annualBasis }),
  ];

  const liquidity: RatioResult[] = [
    mk("current_ratio", "liquidity", "times", false, !hasBalanceSheet
      ? needsBalanceSheet
      : !isPositive(currentLiabilities)
        ? { value: null, calc: "", unavailable: notes.noCurrentLiabilities }
        : { value: decimalRatio(currentAssets, currentLiabilities), calc: `${M(currentAssets)} / ${M(currentLiabilities)}` }),
    mk("quick_ratio", "liquidity", "times", false, !hasBalanceSheet
      ? needsBalanceSheet
      : !isPositive(currentLiabilities)
        ? { value: null, calc: "", unavailable: notes.noCurrentLiabilities }
        : { value: decimalRatio(quickAssets, currentLiabilities), calc: `${M(quickAssets)} / ${M(currentLiabilities)}` }),
    mk("working_capital", "liquidity", "money", false, !hasBalanceSheet
      ? needsBalanceSheet
      : { value: workingCapital, calc: `${M(currentAssets)} − ${M(currentLiabilities)}` }),
  ];

  const solvency: RatioResult[] = [
    mk("debt_to_equity", "solvency", "times", true, debt === null
      ? { value: null, calc: "", unavailable: notes.debtNotClassified }
      : overEquity(debt, M(debt))),
    mk("liabilities_to_equity", "solvency", "times", true, overEquity(totalLiabilities, M(totalLiabilities))),
    mk("interest_coverage", "solvency", "times", false, interestExpense === null
      ? { value: null, calc: "", unavailable: notes.interestNotClassified }
      : !isPositive(interestExpense)
        ? { value: null, calc: "", unavailable: notes.noInterestExpense }
        : { value: decimalRatio(operatingIncome, interestExpense), calc: `${M(operatingIncome)} / ${M(interestExpense)}` }),
  ];

  const perHead = (n: ExactDecimal) => (headcount > 0
    ? { value: decimalRatio(annualize(n), String(headcount)), calc: notes.perEmployees(M(annualize(n)), headcount), basis: annualBasis }
    : { value: null, calc: "", unavailable: notes.noHeadcount });
  const efficiency: RatioResult[] = [
    mk("rev_per_employee", "efficiency", "money", false, perHead(revenue)),
    mk("gp_per_employee", "efficiency", "money", false, perHead(grossProfit)),
    mk("asset_turnover", "efficiency", "times", false, !hasBalanceSheet || !isPositive(totalAssets)
      ? needsBalanceSheet
      : { value: decimalRatio(annualize(revenue), totalAssets), calc: `${M(annualize(revenue))} / ${M(totalAssets)}`, basis: annualBasis }),
  ];

  const operating: RatioResult[] = [
    mk("cogs_ratio", "operating", "pct", true, ofRevenue(cogs)),
    mk("opex_ratio", "operating", "pct", true, ofRevenue(opex)),
    mk("operating_leverage", "operating", "times", false, operatingLeverage === null
      ? { value: null, calc: "", unavailable: notes.noPriorComparison }
      : { value: operatingLeverage, calc: `${pctText(opIncGrowth!)} / ${pctText(revenueGrowth!)}` }),
    mk("rule_of_40", "operating", "points", false, rule40 === null
      ? { value: null, calc: "", unavailable: notes.noPriorComparison }
      : { value: rule40, calc: `${pctText(revenueGrowth!)} + ${pctText(operatingMargin!)}` }),
  ];

  const ratios: Record<RatioCategory, RatioResult[]> = { profitability, liquidity, solvency, efficiency, operating };

  // A category scores only from ratios it could grade; the overall score
  // averages only categories that have a score — a genuine zero counts.
  const categoryScores: CategoryScore[] = RATIO_CATEGORIES.map((key) => {
    const scored = ratios[key].map((r) => r.score).filter((s): s is number => s !== null);
    return { key, score: scored.length ? scored.reduce((a, s) => a + s, 0) / scored.length : null };
  });
  const present = categoryScores.map((c) => c.score).filter((s): s is number => s !== null);
  const overallScore = present.length ? present.reduce((a, s) => a + s, 0) / present.length : null;

  return {
    period: { from, to, label, days: periodDays, fiscalYearDays: yearDays },
    prior,
    currency,
    hasBalanceSheet,
    figures: {
      revenue, operatingRevenue, otherIncome, cogs, grossProfit, opex, operatingIncome, otherExpense,
      incomeTaxExpense: taxExpense, netIncome, preTaxIncome, depreciationAmortization: da, ebitda,
      totalAssets, currentAssets, quickAssets, totalLiabilities, currentLiabilities, totalEquity,
      workingCapital, capitalEmployed, interestBearingDebt: debt, interestExpense, investedCapital,
      priorRevenue, priorOperatingIncome, revenueGrowth, operatingLeverage, rule40, breakevenRevenue,
      headcount,
    },
    priorFigures: {
      revenue: priorPl.revenue, cogs: priorPl.cogs, grossProfit: priorPl.grossProfit,
      opex: decimalSubtract(totalOf(priorPl.items, [...OPERATING_EXPENSE_TYPES]), priorTaxInOpex),
      operatingIncome: priorOperatingIncome,
      otherExpense: totalOf(priorPl.items, ['expense_other']), netIncome: priorPl.netIncome,
    },
    ratios,
    categoryScores,
    overallScore,
    scoreLabel: scoreLabelOf(overallScore, benchmarks),
    benchmarks,
    ratioInputs,
  };

  function pctText(fraction: ExactDecimal): string {
    return notes.percent(fraction);
  }

  async function nopatTaxRate(
    org: string,
    asOf: string,
    scope: { id: string | null }[],
    booked: ExactDecimal | null,
    pretax: ExactDecimal,
  ): Promise<{ rate: ExactDecimal | null; basis: string | null; reason: string }> {
    if (booked !== null && isPositive(pretax) && cmp(booked, ZERO) > 0) {
      const effective = decimalRatio(booked, pretax)!;
      return { rate: effective, basis: notes.effectiveTaxRate(notes.percent(effective)), reason: "" };
    }
    // No booked tax for the period: every entity in scope must be taxed at the
    // same enacted rate, or there is no single rate to apply.
    const rates = await Promise.all(scope.map((e) => enactedIncomeTaxRate(org, e.id, asOf)));
    if (rates.length === 0 || rates.some((r) => r === null)) return { rate: null, basis: null, reason: notes.noTaxRate };
    const distinct = new Set(rates.map((r) => r!.ratePercent));
    if (distinct.size > 1) return { rate: null, basis: null, reason: notes.mixedTaxRates };
    const statutory = decimalRatio(rates[0]!.ratePercent, "100")!;
    return { rate: statutory, basis: notes.statutoryTaxRate(notes.percent(statutory)), reason: "" };
  }
}

/** Translated period activity on the given accounts, restricted to accounts of the given types. */
async function accountActivityOfTypes(
  orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null, accountIds: string[], types: string[],
): Promise<ExactDecimal> {
  const r = await analyticsQuery<{ id: string }>(sql`
    select id from accounts
     where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])
       and type = any(${`{${types.join(",")}}`}::text[])
  `);
  return accountActivity(orgId, from, to, allowed, r.rows.map((row) => row.id));
}
