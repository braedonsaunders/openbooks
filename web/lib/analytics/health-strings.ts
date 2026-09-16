/**
 * Localizable sentence templates for financial health (health-data findings,
 * P&L/margin labels, month labels).
 *
 * Same pattern as the other analytics bundles: `englishHealthStrings` is the
 * exact legacy English copy (direct callers keep byte-identical output);
 * `healthStrings(t)` builds the catalog-backed bundle from
 * `getTranslations('analytics')` in the request locale. P&L and margin-flow
 * line names reuse the reviewed `financialHealth.pnl.*` keys — the client
 * renders loader labels verbatim, so there is exactly one source for each
 * line name. Percents travel pre-rendered (legacy toFixed shapes); money
 * travels through the existing locale-aware formatter.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";

export type PnlLineKey =
  | "revenue" | "cogs" | "grossProfit" | "opex"
  | "operatingIncome" | "otherExpense" | "netIncome";

export type MarginStageKey = PnlLineKey | "excludeOtherIncome" | "otherIncome";

export interface HealthFinding {
  severity: "issue" | "rec" | "anomaly";
  title: string;
  detail: string;
}

/** No-data notes inside the ratio engine (financial-health.ts core). */
export interface FinancialHealthNotes {
  noDA: string;
  noBalanceSheet: string;
  noHeadcount: string;
  noInterestExpense: string;
  /** `revenue` is pre-formatted money (existing formatter). */
  perEmployees(revenue: string, headcount: number): string;
}

export interface HealthStrings extends FinancialHealthNotes {
  locale: string;
  monthLabel(ym: string): string;
  /** Map the SQL `coalesce(…, 'Unassigned')` sentinel to the request language. */
  displaySegmentName(id: string, name: string): string;
  pnlLine(key: PnlLineKey): string;
  marginStage(key: MarginStageKey): string;
  operatingLoss(amount: string): HealthFinding;
  gmCritical(actual: string, target: string): HealthFinding;
  gmWellBelow(actual: string, target: string): HealthFinding;
  gmBelow(actual: string, target: string): HealthFinding;
  opmCritical(actual: string, target: string): HealthFinding;
  opmBelow(actual: string, target: string): HealthFinding;
  netLoss(amount: string): HealthFinding;
  revFalling(pct: string): HealthFinding;
  revDeclined(pct: string): HealthFinding;
  revTrendingDown(pct: string): HealthFinding;
  marginCompression(pp: string): HealthFinding;
  belowBreakeven(amount: string): HealthFinding;
  thinMargin(pct: string): HealthFinding;
  heavyOverhead(pct: string): HealthFinding;
  healthyGM: HealthFinding;
  trimOpex: HealthFinding;
  posLeverage(x: string): HealthFinding;
  rule40(n: string): HealthFinding;
  marginOutlier(month: string, actual: string, avg: string): HealthFinding;
  revenueSpike(month: string, amount: string, avg: string): HealthFinding;
}

function legacyMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1, 1));
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} '${String(y).slice(2)}`;
}

const PNL: Record<PnlLineKey, string> = {
  revenue: "Revenue",
  cogs: "Cost of Goods Sold",
  grossProfit: "Gross Profit",
  opex: "Operating Expenses",
  operatingIncome: "Operating Income",
  otherExpense: "Other Expense",
  netIncome: "Net Income",
};

const MARGIN: Record<MarginStageKey, string> = {
  ...PNL,
  excludeOtherIncome: "Exclude Other Income",
  otherIncome: "Other Income",
};

/** Exact legacy English no-data notes (byte-identical to the ratio engine). */
export const englishFinancialHealthNotes: FinancialHealthNotes = {
  noDA: "No depreciation/amortization accounts found",
  noBalanceSheet: "No balance sheet data",
  noHeadcount: "No active employee records",
  noInterestExpense: "No interest expense",
  perEmployees: (revenue, headcount) => `${revenue} / ${headcount} employees`,
};

/** Exact legacy English sentences (byte-identical to the pre-catalog loader). */
export const englishHealthStrings: HealthStrings = {
  locale: "en",
  ...englishFinancialHealthNotes,
  monthLabel: legacyMonthLabel,
  displaySegmentName: (_id, name) => name,
  pnlLine: (key) => PNL[key],
  marginStage: (key) => (key === "cogs" ? "COGS" : MARGIN[key]),
  operatingLoss: (amount) => ({ severity: "issue", title: "Operating loss", detail: `Operating income is ${amount} — the business loses money before other items.` }),
  gmCritical: (actual, target) => ({ severity: "issue", title: "Gross margin critically low", detail: `Gross margin is ${actual}% — less than half the ${target}% target.` }),
  gmWellBelow: (actual, target) => ({ severity: "issue", title: "Gross margin well below target", detail: `Gross margin is ${actual}% vs the ${target}% target.` }),
  gmBelow: (actual, target) => ({ severity: "issue", title: "Gross margin below target", detail: `Gross margin is ${actual}% vs a ${target}% benchmark.` }),
  opmCritical: (actual, target) => ({ severity: "issue", title: "Operating margin critically low", detail: `Operating margin is ${actual}% — less than half the ${target}% target.` }),
  opmBelow: (actual, target) => ({ severity: "issue", title: "Operating margin below target", detail: `Operating margin is ${actual}% vs a ${target}% benchmark.` }),
  netLoss: (amount) => ({ severity: "issue", title: "Net loss for the period", detail: `Net income is ${amount}.` }),
  revFalling: (pct) => ({ severity: "issue", title: "Revenue falling sharply year-over-year", detail: `Revenue is down ${pct}% vs the prior year.` }),
  revDeclined: (pct) => ({ severity: "issue", title: "Revenue declined year-over-year", detail: `Revenue is down ${pct}% vs the prior year.` }),
  revTrendingDown: (pct) => ({ severity: "issue", title: "Revenue trending down", detail: `Revenue fell ${pct}% across the last three active months.` }),
  marginCompression: (pp) => ({ severity: "issue", title: "Margin compression", detail: `Gross margin slid ${pp}pp over the last three active months.` }),
  belowBreakeven: (amount) => ({ severity: "issue", title: "Below breakeven", detail: `Average monthly revenue is under the approximately ${amount} breakeven.` }),
  thinMargin: (pct) => ({ severity: "issue", title: "Thin safety margin", detail: `Only ${pct}% of monthly revenue separates you from breakeven.` }),
  heavyOverhead: (pct) => ({ severity: "issue", title: "Heavy overhead", detail: `Operating expenses are ${pct}% of revenue (>40%).` }),
  healthyGM: { severity: "rec", title: "Healthy gross margin", detail: "Direct-cost discipline is on track — protect pricing." },
  trimOpex: { severity: "rec", title: "Trim operating expense", detail: "Gross margin is fine; the gap to operating margin is overhead — review OpEx." },
  posLeverage: (x) => ({ severity: "rec", title: "Positive operating leverage", detail: `Operating income scales ${x}× revenue — lean into growth.` }),
  rule40: (n) => ({ severity: "rec", title: "Passing the Rule of 40", detail: `Growth + margin = ${n}.` }),
  marginOutlier: (month, actual, avg) => ({ severity: "anomaly", title: `Margin outlier in ${month}`, detail: `Gross margin ${actual}% vs ${avg}% average.` }),
  revenueSpike: (month, amount, avg) => ({ severity: "anomaly", title: `Revenue spike/dip in ${month}`, detail: `Revenue ${amount} vs ${avg} average.` }),
};

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function healthStrings(t: CatalogMessageFn, locale: string): HealthStrings {
  const issue = (key: string, detail?: Record<string, string>): HealthFinding => ({
    severity: "issue",
    title: t(`financialHealth.findings.${key}.title`),
    detail: t(`financialHealth.findings.${key}.detail`, detail),
  });
  const rec = (key: string, detail?: Record<string, string>): HealthFinding => ({
    severity: "rec",
    title: t(`financialHealth.findings.${key}.title`),
    detail: t(`financialHealth.findings.${key}.detail`, detail),
  });
  return {
    locale,
    noDA: t("financialHealth.ratioNotes.noDA"),
    noBalanceSheet: t("financialHealth.ratioNotes.noBalanceSheet"),
    noHeadcount: t("financialHealth.ratioNotes.noHeadcount"),
    noInterestExpense: t("financialHealth.ratioNotes.noInterestExpense"),
    perEmployees: (revenue, headcount) =>
      t("financialHealth.ratioNotes.perEmployees", { revenue, count: headcount }),
    monthLabel: catalogMonthLabel(t),
    displaySegmentName: (id, name) =>
      id === "unassigned" && name === "Unassigned" ? t("financialHealth.labels.unassignedSegment") : name,
    pnlLine: (key) => t(`financialHealth.pnl.${key}`),
    // The waterfall historically abbreviated COGS; the catalog carries the
    // reviewed long form everywhere, so every language reads a real word.
    marginStage: (key) => t(`financialHealth.pnl.${key}`),
    operatingLoss: (amount) => issue("operatingLoss", { amount }),
    gmCritical: (actual, target) => issue("gmCritical", { actual, target }),
    gmWellBelow: (actual, target) => issue("gmWellBelow", { actual, target }),
    gmBelow: (actual, target) => issue("gmBelow", { actual, target }),
    opmCritical: (actual, target) => issue("opmCritical", { actual, target }),
    opmBelow: (actual, target) => issue("opmBelow", { actual, target }),
    netLoss: (amount) => issue("netLoss", { amount }),
    revFalling: (pct) => issue("revFalling", { pct }),
    revDeclined: (pct) => issue("revDeclined", { pct }),
    revTrendingDown: (pct) => issue("revTrendingDown", { pct }),
    marginCompression: (pp) => issue("marginCompression", { pp }),
    belowBreakeven: (amount) => issue("belowBreakeven", { amount }),
    thinMargin: (pct) => issue("thinMargin", { pct }),
    heavyOverhead: (pct) => issue("heavyOverhead", { pct }),
    healthyGM: rec("healthyGM"),
    trimOpex: rec("trimOpex"),
    posLeverage: (x) => rec("posLeverage", { x }),
    rule40: (n) => rec("rule40", { n }),
    marginOutlier: (month, actual, avg) => ({
      severity: "anomaly",
      title: t("financialHealth.findings.marginOutlier.title", { month }),
      detail: t("financialHealth.findings.marginOutlier.detail", { actual, avg }),
    }),
    revenueSpike: (month, amount, avg) => ({
      severity: "anomaly",
      title: t("financialHealth.findings.revenueSpike.title", { month }),
      detail: t("financialHealth.findings.revenueSpike.detail", { amount, avg }),
    }),
  };
}

const RATIO_IDS = [
  "gross_margin",
  "operating_margin",
  "ebitda_margin",
  "net_margin",
  "roa",
  "roe",
  "roic",
  "roce",
  "rev_per_employee",
  "gp_per_employee",
  "asset_turnover",
  "cogs_ratio",
  "opex_ratio",
  "operating_leverage",
  "interest_coverage",
  "rule_of_40",
] as const;

export interface RatioDefText {
  label: string;
  formula: string;
  desc: string;
  interpret: string;
}

/**
 * Catalog-backed ratio dictionary — same shape as RATIO_DEFS, every field in
 * the request locale. RATIO_DEFS itself stays the static English table for
 * surfaces outside the analytics dashboards.
 */
export function localizedRatioDefs(t: CatalogMessageFn): Record<string, RatioDefText> {
  return Object.fromEntries(
    RATIO_IDS.map((id) => [
      id,
      {
        label: t(`financialHealth.ratios.${id}.label`),
        formula: t(`financialHealth.ratios.${id}.formula`),
        desc: t(`financialHealth.ratios.${id}.desc`),
        interpret: t(`financialHealth.ratios.${id}.interpret`),
      },
    ]),
  );
}
