/**
 * Localizable sentence templates for customer intelligence.
 *
 * Same pattern as spend-velocity-strings: `englishCustomerStrings` is the
 * exact legacy English copy (direct callers keep byte-identical output);
 * `customerStrings(t)` builds the catalog-backed bundle from
 * `getTranslations('analytics')` in the request locale. Counts travel as
 * numbers into ICU plurals; pre-formatted money travels as strings.
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
}

/** Exact legacy English sentences (byte-identical to the pre-catalog loader). */
export const englishCustomerStrings: CustomerStrings = {
  locale: "en",
  monthLabel: (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  },
  displayCustomerName: (name) => (name === "Unknown" ? "Unknown" : name),
  displayJobName: (name) => (name === "Untitled project" ? "Untitled project" : name),
  churnInactive: (days) => `No activity in ${days} days`,
  churnDeclining: "Declining engagement",
  churnBelowPattern: "Below typical purchase pattern",
  churnSingle: "Single transaction customer",
  churnLowFrequency: "Low transaction frequency",
  recMaintain: "Continue current engagement strategy",
  recFriction: (credits) => `High friction: ${credits} credits — address issues immediately`,
  recOverdue: (overdueDays, cycleDays) => `${overdueDays} days overdue for order (avg cycle: ${cycleDays} days)`,
  recWinBack: "At risk of churn — immediate outreach needed",
  recNurture: "High-value customer — prioritize relationship",
  recOnboard: "New customer — focus on successful onboarding",
  recReprice: (marginPct) => `High revenue but low margin (${marginPct}%) — review pricing`,
  recReview: "Low engagement — evaluate account strategy",
  intelligenceScore: (score) => {
    if (score < 40) return { label: "Needs Attention", grade: "D" };
    if (score < 55) return { label: "Fair", grade: "C" };
    if (score < 70) return { label: "Good", grade: "B" };
    if (score < 85) return { label: "Very Good", grade: "B+" };
    return { label: "Excellent", grade: "A" };
  },
  projectedClv: (amount, years, customers) => ({
    title: "Projected Customer Value",
    message: `${amount} projected CLV over ${years} years from ${customers} customers`,
  }),
  churnRisk: (count, revenue) => ({
    title: "Churn Risk Alert",
    message: `${count} customers at high/critical churn risk representing ${revenue} revenue`,
    action: "Initiate win-back campaigns for at-risk customers",
  }),
  champions: (count, revenue) => ({
    title: "Champion Customers",
    message: `${count} champion customers generating ${revenue}`,
    action: "Maintain VIP treatment and referral programs",
  }),
  concentration: (share, hhi) => ({
    title: "Revenue Concentration Risk",
    message: `Top customer accounts for ${share}% of revenue. HHI: ${hhi}`,
    action: "Diversify customer base to reduce dependency",
  }),
  declining: (growth) => ({
    title: "Declining Revenue Trend",
    message: `Average monthly growth of ${growth}%`,
    action: "Review customer acquisition and retention strategies",
  }),
  growing: (growth, newCustomers) => ({
    title: "Strong Growth Trajectory",
    message: `${growth}% average monthly growth with ${newCustomers} new customers`,
  }),
  overdue: (count) => ({
    title: "Overdue Invoices",
    message: `${count} overdue invoices require attention`,
    action: "Review collections process and payment terms",
  }),
};

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
  };
}
