/**
 * Localizable sentence templates for customer intelligence.
 *
 * `customerStrings(t)` builds the bundle from `getTranslations('analytics')`
 * in the request locale. Counts travel as numbers into ICU plurals;
 * pre-formatted money travels as strings.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";


export interface CustomerInsightText {
  title: string;
  message: string;
  action?: string;
}

/** Cut-offs of the grade ladder shared by the health and intelligence grades. */
export interface GradeLadder {
  aPlus: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface CustomerStrings {
  locale: string;
  monthLabel(ym: string): string;
  /** Map the SQL `coalesce(…, 'Unknown')` sentinel to the request language. */
  displayCustomerName(name: string): string;
  displayJobName(name: string): string;
  churnInactive(days: number): string;
  churnDeclining: string;
  churnBelowPattern: string;
  churnSingle: string;
  churnLowFrequency: string;
  recMaintain: string;
  recFriction(credits: number): string;
  recOverdue(overdueDays: number, cycleDays: number): string;
  recWinBack: string;
  recNurture: string;
  recOnboard: string;
  /** `marginPct` renders with one decimal in the request locale. */
  recReprice(marginPct: number): string;
  recReview: string;
  /** The shared A+/A/B/C/D/F grade ladder, read from the scoring config. */
  intelligenceScore(score: number, grades: GradeLadder): { label: string; grade: string };
  /** `amount` is pre-formatted money (existing locale-aware formatter). */
  projectedClv(amount: string, years: number, customers: number): CustomerInsightText;
  churnRisk(count: number, revenue: string): CustomerInsightText;
  champions(count: number, revenue: string): CustomerInsightText;
  /** `share` is pre-rendered (legacy toFixed(1)). */
  /** Both figures render in the request locale: share with one decimal, HHI grouped. */
  concentration(share: number, hhi: number): CustomerInsightText;
  declining(growth: number): CustomerInsightText;
  growing(growth: number, newCustomers: number): CustomerInsightText;
  overdue(count: number): CustomerInsightText;
  /** Loader refusal when the settlement pipeline yields no payment statistics. */
  paymentStatsUnavailable(): string;
  /** Loader refusal when a hand-edited weight group no longer sums to 100. */
  scoringWeightsInvalid(keys: string[], total: number, actual: number): string;
  /** Loader refusal when a hand-edited weight is missing or not a number. */
  scoringWeightsUnreadable(keys: string[]): string;
  /** Loader refusal when no intelligence term carries weight under the configured weights. */
  intelligenceUnavailable(): string;
}

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function customerStrings(t: CatalogMessageFn, locale: string): CustomerStrings {
  const monthLabel = catalogMonthLabel(t);
  // Percents render in the request locale (12,3 not 12.3): numeric args
  // arrive unformatted and cross here, never via toFixed upstream.
  const pct1 = (value: number): string =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  const int0 = (value: number): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  const fieldLabel = (key: string): string => {
    try {
      return t(`customer.config.fields.${key}.label` as Parameters<typeof t>[0]);
    } catch {
      return key;
    }
  };
  return {
    locale,
    monthLabel,
    displayCustomerName: (name) => (name === "Unknown" ? t("customer.labels.unknownCustomer") : name),
    displayJobName: (name) => (name === "Untitled project" ? t("customer.labels.untitledProject") : name),
    churnInactive: (days) => t("customer.insights.churnInactive", { days }),
    churnDeclining: t("customer.insights.churnDeclining"),
    churnBelowPattern: t("customer.insights.churnBelowPattern"),
    churnSingle: t("customer.insights.churnSingle"),
    churnLowFrequency: t("customer.insights.churnLowFrequency"),
    recMaintain: t("customer.insights.recMaintain"),
    recFriction: (credits) => t("customer.insights.recFriction", { count: credits }),
    recOverdue: (overdueDays, cycleDays) => t("customer.insights.recOverdue", { overdue: overdueDays, cycle: cycleDays }),
    recWinBack: t("customer.insights.recWinBack"),
    recNurture: t("customer.insights.recNurture"),
    recOnboard: t("customer.insights.recOnboard"),
    recReprice: (marginPct) => t("customer.insights.recReprice", { pct: pct1(marginPct) }),
    recReview: t("customer.insights.recReview"),
    intelligenceScore: (score, grades) => {
      if (score >= grades.aPlus) return { label: t("customer.insights.scoreExcellent"), grade: "A+" };
      if (score >= grades.a) return { label: t("customer.insights.scoreVeryGood"), grade: "A" };
      if (score >= grades.b) return { label: t("customer.insights.scoreGood"), grade: "B" };
      if (score >= grades.c) return { label: t("customer.insights.scoreFair"), grade: "C" };
      if (score >= grades.d) return { label: t("customer.insights.scoreNeedsAttention"), grade: "D" };
      return { label: t("customer.insights.scoreNeedsAttention"), grade: "F" };
    },
    projectedClv: (amount, years, customers) => ({
      title: t("customer.insights.projectedClv.title"),
      message: t("customer.insights.projectedClv.message", { amount, years, count: customers }),
    }),
    churnRisk: (count, revenue) => ({
      title: t("customer.insights.churnRisk.title"),
      message: t("customer.insights.churnRisk.message", { count, amount: revenue }),
      action: t("customer.insights.churnRisk.action"),
    }),
    champions: (count, revenue) => ({
      title: t("customer.insights.champions.title"),
      message: t("customer.insights.champions.message", { count, amount: revenue }),
      action: t("customer.insights.champions.action"),
    }),
    concentration: (share, hhi) => ({
      title: t("customer.insights.concentration.title"),
      message: t("customer.insights.concentration.message", { share: pct1(share), hhi: int0(hhi) }),
      action: t("customer.insights.concentration.action"),
    }),
    declining: (growth) => ({
      title: t("customer.insights.declining.title"),
      message: t("customer.insights.declining.message", { growth }),
      action: t("customer.insights.declining.action"),
    }),
    growing: (growth, newCustomers) => ({
      title: t("customer.insights.growing.title"),
      message: t("customer.insights.growing.message", { growth, count: newCustomers }),
    }),
    overdue: (count) => ({
      title: t("customer.insights.overdue.title"),
      message: t("customer.insights.overdue.message", { count }),
      action: t("customer.insights.overdue.action"),
    }),
    paymentStatsUnavailable: () => t("customer.errors.paymentStatsUnavailable"),
    scoringWeightsInvalid: (keys, total, actual) =>
      t("customer.errors.scoringWeightsInvalid", {
        // Operators fix fields by their translated editor labels, never by
        // the camelCase storage keys — an unknown key renders raw rather
        // than dropping the refusal.
        keys: keys.map(fieldLabel).join(", "),
        total,
        actual,
      }),
    scoringWeightsUnreadable: (keys) =>
      t("customer.errors.scoringWeightsUnreadable", { keys: keys.map(fieldLabel).join(", ") }),
    intelligenceUnavailable: () => t("customer.errors.intelligenceUnavailable"),
  };
}
