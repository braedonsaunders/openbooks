/**
 * Localizable sentence templates for financial health (health-data findings,
 * P&L/margin labels, month labels).
 *
 * `healthStrings(t)` builds the bundle from `getTranslations('analytics')`
 * in the request locale. P&L and margin-flow line names reuse the reviewed
 * `financialHealth.pnl.*` keys — the client renders loader labels verbatim,
 * so there is exactly one source for each line name. Percents travel
 * pre-rendered; money travels through the existing locale-aware formatter.
 */

import type { AnalyticsFindingKey, CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";
import { RATIO_IDS } from "./ratio-ids";


export type PnlLineKey =
  | "revenue" | "cogs" | "grossProfit" | "opex"
  | "operatingIncome" | "otherExpense" | "netIncome";

export type MarginStageKey = PnlLineKey | "excludeOtherIncome" | "otherIncome";

export interface HealthFinding {
  severity: "issue" | "rec" | "anomaly";
  title: string;
  detail: string;
}

/** Reasons and measurement notes inside the ratio engine (financial-health.ts). */
export interface FinancialHealthNotes {
  unavailable: string;
  noRevenue: string;
  noDA: string;
  noBalanceSheet: string;
  noHeadcount: string;
  noInterestExpense: string;
  noCurrentLiabilities: string;
  noPriorComparison: string;
  equityNotPositive: string;
  investedCapitalNotPositive: string;
  debtNotClassified: string;
  interestNotClassified: string;
  noTaxRate: string;
  mixedTaxRates: string;
  /** `revenue` is pre-formatted money (existing formatter). */
  perEmployees(revenue: string, headcount: number): string;
  annualized(periodDays: number, yearDays: number): string;
  effectiveTaxRate(rate: string): string;
  statutoryTaxRate(rate: string): string;
  /** An exact fraction rendered as a percentage in the request locale. */
  percent(fraction: string): string;
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

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function healthStrings(t: CatalogMessageFn, locale: string): HealthStrings {
  const issue = (key: AnalyticsFindingKey, detail?: Record<string, string>): HealthFinding => ({
    severity: "issue",
    title: t(`financialHealth.findings.${key}.title`),
    detail: t(`financialHealth.findings.${key}.detail`, detail),
  });
  const rec = (key: AnalyticsFindingKey, detail?: Record<string, string>): HealthFinding => ({
    severity: "rec",
    title: t(`financialHealth.findings.${key}.title`),
    detail: t(`financialHealth.findings.${key}.detail`, detail),
  });
  return {
    locale,
    unavailable: t("financialHealth.ratioNotes.unavailable"),
    noRevenue: t("financialHealth.ratioNotes.noRevenue"),
    noDA: t("financialHealth.ratioNotes.noDA"),
    noBalanceSheet: t("financialHealth.ratioNotes.noBalanceSheet"),
    noHeadcount: t("financialHealth.ratioNotes.noHeadcount"),
    noInterestExpense: t("financialHealth.ratioNotes.noInterestExpense"),
    noCurrentLiabilities: t("financialHealth.ratioNotes.noCurrentLiabilities"),
    noPriorComparison: t("financialHealth.ratioNotes.noPriorComparison"),
    equityNotPositive: t("financialHealth.ratioNotes.equityNotPositive"),
    investedCapitalNotPositive: t("financialHealth.ratioNotes.investedCapitalNotPositive"),
    debtNotClassified: t("financialHealth.ratioNotes.debtNotClassified"),
    interestNotClassified: t("financialHealth.ratioNotes.interestNotClassified"),
    noTaxRate: t("financialHealth.ratioNotes.noTaxRate"),
    mixedTaxRates: t("financialHealth.ratioNotes.mixedTaxRates"),
    perEmployees: (revenue, headcount) =>
      t("financialHealth.ratioNotes.perEmployees", { revenue, count: headcount }),
    annualized: (periodDays, yearDays) =>
      t("financialHealth.ratioNotes.annualized", { periodDays, yearDays }),
    effectiveTaxRate: (rate) => t("financialHealth.ratioNotes.effectiveTaxRate", { rate }),
    statutoryTaxRate: (rate) => t("financialHealth.ratioNotes.statutoryTaxRate", { rate }),
    percent: (fraction) =>
      new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(fraction as unknown as number),
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


export interface RatioDefText {
  label: string;
  formula: string;
  desc: string;
  interpret: string;
}

/**
 * Catalog-backed ratio dictionary, every field in the request locale. The
 * catalog is the only copy of these definitions.
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
