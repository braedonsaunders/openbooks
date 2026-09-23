/**
 * Localizable sentence templates for utilization (Billable IQ).
 *
 * Same pattern as the other analytics bundles: `englishUtilizationStrings`
 * is the exact legacy English copy (direct callers keep byte-identical
 * output); `utilizationStrings(t)` builds the catalog-backed bundle from
 * `getTranslations('analytics')` in the request locale. The history-period
 * labels reuse the shared month template; alert thresholds travel as numbers
 * and pre-formatted money travels as strings.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";

/** en-US short month names, Jan→Dec — the exact legacy toLocaleString rendering. */
const LEGACY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface UtilizationAlert {
  type: "warning" | "danger";
  message: string;
}

export interface UtilizationStrings {
  locale: string;
  monthLabel(ym: string): string;
  /** Map a null group display name (SQL miss) to the request language. */
  displayGroupName(name: string | null | undefined): string;
  /** Map the `No Title` fallback (no dominant labour class) to the request language. */
  displayEmployeeTitle(title: string | null | undefined): string;
  /** Map a missing department display name to the request language. */
  displayDepartmentName(name: string | null | undefined): string;
  alertBelowTarget(target: number): UtilizationAlert;
  /** `amount` is pre-formatted money (existing locale-aware formatter). */
  alertCostSpike(amount: string): UtilizationAlert;
}

/** Exact legacy English sentences (byte-identical to the pre-catalog loader). */
export const englishUtilizationStrings: UtilizationStrings = {
  locale: "en",
  monthLabel: (ym) => {
    // Static table, never a Date: the label only reads the month name and the
    // year suffix from the parsed numbers, so output is identical at every year.
    const [y, m] = ym.split("-").map(Number);
    return `${LEGACY_MONTHS[((m ?? 1) - 1 + 12) % 12] ?? ym} '${String(y ?? "").slice(2)}`;
  },
  displayGroupName: (name) => name ?? "Unknown",
  displayEmployeeTitle: (title) => title ?? "No Title",
  displayDepartmentName: (name) => name ?? "Unknown",
  alertBelowTarget: (target) => ({ type: "warning", message: `Billable % below ${target}% target` }),
  alertCostSpike: (amount) => ({ type: "danger", message: `Non-billable cost spiked by ${amount}` }),
};

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function utilizationStrings(t: CatalogMessageFn, locale: string): UtilizationStrings {
  return {
    locale,
    monthLabel: catalogMonthLabel(t),
    displayGroupName: (name) => (name === null || name === undefined || name === "Unknown" ? t("utilization.labels.unknownName") : name),
    displayEmployeeTitle: (title) => (title === null || title === undefined || title === "No Title" ? t("utilization.labels.noTitle") : title),
    displayDepartmentName: (name) => (name === null || name === undefined || name === "Unknown" ? t("utilization.labels.unknownName") : name),
    alertBelowTarget: (target) => ({ type: "warning", message: t("utilization.alerts.belowTarget", { target }) }),
    alertCostSpike: (amount) => ({ type: "danger", message: t("utilization.alerts.costSpike", { amount }) }),
  };
}
