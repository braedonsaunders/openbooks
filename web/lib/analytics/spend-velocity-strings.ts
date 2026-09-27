/**
 * Localizable sentence templates for the spend-velocity insight engine.
 *
 * The loader (`spend-velocity-data.ts`) computes numbers and picks rules; every
 * user-facing word comes from here. Request-scoped dashboards build a bundle
 * with `spendVelocityStrings(t, locale)` where `t` resolves through
 * `getTranslations('analytics')`, i.e. the request locale (users.locale ??
 * org defaultLocale ?? en) with English fallback — the same locale statements
 * use.
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
