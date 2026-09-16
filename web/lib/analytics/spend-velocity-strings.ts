/**
 * Localizable sentence templates for the spend-velocity insight engine.
 *
 * The loader (`spend-velocity-data.ts`) computes numbers and picks rules; every
 * user-facing word comes from here. `englishSpendVelocityStrings` is the exact
 * legacy English copy — direct callers (unit tests, assistant tools) keep
 * byte-identical output by omitting the bundle. Request-scoped dashboards
 * build a catalog-backed bundle with `spendVelocityStrings(t, locale)` where
 * `t` resolves through `getTranslations('analytics')`, i.e. the request locale
 * (users.locale ?? org defaultLocale ?? en) with English fallback — the same
 * locale statements use.
 *
 * Counts travel as NUMBERS into ICU `{count, plural, …}` forms (never
 * `account(s)` string hacks); already-formatted money travels as strings via
 * the existing locale-aware money formatter. Month-name lists join with
 * `Intl.ListFormat` in the request locale.
 */

export type { CatalogMessageFn } from "./catalog-strings";
import type { CatalogMessageFn } from "./catalog-strings";
import { MONTH_KEYS } from "./catalog-strings";

export interface SpendVelocityInsightText {
  title: string;
  message: string;
  action: string;
}

export interface SpendVelocityStrings {
  locale: string;
  /** 12 short month names, Jan→Dec, in the request language. */
  shortMonths: string[];
  /** "Mar '26" style month label from a short month name + 2-digit year. */
  monthYear(month: string, yy: string): string;
  highGrowth(count: number): SpendVelocityInsightText;
  /** `faster` is "bills" | "expenses"; `gapPct` is the rounded |bills−expenses|. */
  typeImbalance(faster: "bills" | "expenses", gapPct: number): SpendVelocityInsightText;
  anomalies(criticalCount: number): SpendVelocityInsightText;
  creep(count: number): SpendVelocityInsightText;
  concentration(top1SharePct: number): SpendVelocityInsightText;
  /** `annualCost` is pre-formatted money (existing formatter). */
  zombies(count: number, annualCost: string): SpendVelocityInsightText;
  fragmentation(categories: number): SpendVelocityInsightText;
  opexRatio(pct: number): SpendVelocityInsightText;
  cliff(po: number, so: number, gap: number, ratio: number): SpendVelocityInsightText;
  cliffAction(monthsToCliff: number | null): string;
  seasonalHigh(monthNames: string[]): string;
  seasonalLow(monthNames: string[]): string;
  /** Honest-gap note for the unavailable shadow-IT detector. */
  shadowItReason: string;
}

const LEGACY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Exact legacy English sentences (byte-identical to the pre-catalog loader). */
export const englishSpendVelocityStrings: SpendVelocityStrings = {
  locale: "en",
  shortMonths: [...LEGACY_MONTHS],
  monthYear: (month, yy) => `${month} '${yy}`,
  highGrowth: (count) => ({
    title: "High Growth Expense Categories",
    message: `${count} expense account${count === 1 ? "" : "s"} growing >20%/month`,
    action: "Review spending policies for these categories",
  }),
  typeImbalance: (faster, gapPct) => ({
    title: "Transaction Type Imbalance",
    message: `${faster === "bills" ? "Bills" : "Expense Reports"} growing ${gapPct}% faster than other type`,
    action: "Review approval workflows and spending controls",
  }),
  anomalies: (criticalCount) => ({
    title: "Spending Anomalies Detected",
    message: `${criticalCount} critical anomal${criticalCount === 1 ? "y requires" : "ies require"} investigation`,
    action: "Review flagged transactions for errors or unauthorized spend",
  }),
  creep: (count) => ({
    title: "Gradual Cost Creep Detected",
    message: `${count} account${count === 1 ? "" : "s"} showing consistent increases`,
    action: "Negotiate rates or find alternative solutions",
  }),
  concentration: (top1SharePct) => ({
    title: "High Spend Concentration",
    message: `Top expense category accounts for ${top1SharePct}% of spend`,
    action: "Review for cost optimization opportunities",
  }),
  zombies: (count, annualCost) => ({
    title: "Potential Unused Subscriptions",
    message: `${count} vendor${count === 1 ? "" : "s"} with identical recurring charges (${annualCost}/year)`,
    action: "Review for usage — these may be auto-renewing unused services",
  }),
  fragmentation: (categories) => ({
    title: "Purchasing Fragmentation Detected",
    message: `${categories} categor${categories === 1 ? "y" : "ies"} with high transaction volume and low avg size`,
    action: "Consider vendor consolidation or preferred supplier agreements",
  }),
  opexRatio: (pct) => ({
    title: "High OpEx to Revenue Ratio",
    message: `Operating expenses are ${pct}% of revenue`,
    action: "Review cost structure and identify efficiency opportunities",
  }),
  cliff: (po, so, gap, ratio) => ({
    title: "Purchase-Sales Velocity Imbalance",
    message: `PO velocity (${po}%/mo) exceeds SO velocity (${so}%/mo) by ${gap}% — PO/SO ratio: ${ratio}×`,
    action: "",
  }),
  cliffAction: (monthsToCliff) =>
    monthsToCliff
      ? `Cash pressure risk in ~${monthsToCliff} months. Review purchase commitments.`
      : "Monitor purchase velocity and align with sales pipeline.",
  seasonalHigh: (monthNames) => `Higher spending typically occurs in ${monthNames.join(", ")}`,
  seasonalLow: (monthNames) => `Lower spending typically occurs in ${monthNames.join(", ")}`,
  shadowItReason:
    "Expense-report lines carry no line-level merchant/vendor — only the expense account and a free-text description — so viral software adoption across employees cannot be traced.",
};

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function spendVelocityStrings(t: CatalogMessageFn, locale: string): SpendVelocityStrings {
  const list = (names: string[]): string => {
    try {
      return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  };
  return {
    locale,
    shortMonths: MONTH_KEYS.map((k) => t(`common.monthsShort.${k}`)),
    monthYear: (month, yy) => t("common.monthYear", { month, yy }),
    highGrowth: (count) => ({
      title: t("spendVelocity.insights.highGrowth.title"),
      message: t("spendVelocity.insights.highGrowth.message", { count }),
      action: t("spendVelocity.insights.highGrowth.action"),
    }),
    typeImbalance: (faster, gapPct) => ({
      title: t("spendVelocity.insights.typeImbalance.title"),
      message: t("spendVelocity.insights.typeImbalance.message", {
        faster: t(`spendVelocity.insights.typeImbalance.${faster === "bills" ? "fasterBills" : "fasterExpenses"}`),
        pct: gapPct,
      }),
      action: t("spendVelocity.insights.typeImbalance.action"),
    }),
    anomalies: (criticalCount) => ({
      title: t("spendVelocity.insights.anomalies.title"),
      message: t("spendVelocity.insights.anomalies.message", { count: criticalCount }),
      action: t("spendVelocity.insights.anomalies.action"),
    }),
    creep: (count) => ({
      title: t("spendVelocity.insights.creep.title"),
      message: t("spendVelocity.insights.creep.message", { count }),
      action: t("spendVelocity.insights.creep.action"),
    }),
    concentration: (top1SharePct) => ({
      title: t("spendVelocity.insights.concentration.title"),
      message: t("spendVelocity.insights.concentration.message", { pct: top1SharePct }),
      action: t("spendVelocity.insights.concentration.action"),
    }),
    zombies: (count, annualCost) => ({
      title: t("spendVelocity.insights.zombies.title"),
      message: t("spendVelocity.insights.zombies.message", { count, amount: annualCost }),
      action: t("spendVelocity.insights.zombies.action"),
    }),
    fragmentation: (categories) => ({
      title: t("spendVelocity.insights.fragmentation.title"),
      message: t("spendVelocity.insights.fragmentation.message", { count: categories }),
      action: t("spendVelocity.insights.fragmentation.action"),
    }),
    opexRatio: (pct) => ({
      title: t("spendVelocity.insights.opexRatio.title"),
      message: t("spendVelocity.insights.opexRatio.message", { pct }),
      action: t("spendVelocity.insights.opexRatio.action"),
    }),
    cliff: (po, so, gap, ratio) => ({
      title: t("spendVelocity.insights.cliff.title"),
      message: t("spendVelocity.insights.cliff.message", { po, so, gap, ratio }),
      action: "",
    }),
    cliffAction: (monthsToCliff) =>
      monthsToCliff
        ? t("spendVelocity.insights.cliff.actionWithMonths", { months: monthsToCliff })
        : t("spendVelocity.insights.cliff.actionMonitor"),
    seasonalHigh: (monthNames) => t("spendVelocity.insights.seasonalHigh", { months: list(monthNames) }),
    seasonalLow: (monthNames) => t("spendVelocity.insights.seasonalLow", { months: list(monthNames) }),
    shadowItReason: t("spendVelocity.insights.shadowItReason"),
  };
}
