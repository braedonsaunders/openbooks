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
  /** `marginPct` is pre-rendered ("12.3", matching the legacy toFixed(1)). */
  recReprice(marginPct: string): string;
  recReview: string;
  intelligenceScore(score: number): { label: string; grade: string };
  /** `amount` is pre-formatted money (existing locale-aware formatter). */
  projectedClv(amount: string, years: number, customers: number): CustomerInsightText;
  churnRisk(count: number, revenue: string): CustomerInsightText;
  champions(count: number, revenue: string): CustomerInsightText;
  /** `share` is pre-rendered (legacy toFixed(1)). */
  concentration(share: string, hhi: number): CustomerInsightText;
  declining(growth: number): CustomerInsightText;
  growing(growth: number, newCustomers: number): CustomerInsightText;
  overdue(count: number): CustomerInsightText;
  /** Loader refusal when the settlement pipeline yields no payment statistics. */
  paymentStatsUnavailable(): string;
}

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function customerStrings(t: CatalogMessageFn, locale: string): CustomerStrings {
  const monthLabel = catalogMonthLabel(t);
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
    recReprice: (marginPct) => t("customer.insights.recReprice", { pct: marginPct }),
    recReview: t("customer.insights.recReview"),
    intelligenceScore: (score) => {
      if (score < 40) return { label: t("customer.insights.scoreNeedsAttention"), grade: "D" };
      if (score < 55) return { label: t("customer.insights.scoreFair"), grade: "C" };
      if (score < 70) return { label: t("customer.insights.scoreGood"), grade: "B" };
      if (score < 85) return { label: t("customer.insights.scoreVeryGood"), grade: "B+" };
      return { label: t("customer.insights.scoreExcellent"), grade: "A" };
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
      message: t("customer.insights.concentration.message", { share, hhi }),
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
  };
}
