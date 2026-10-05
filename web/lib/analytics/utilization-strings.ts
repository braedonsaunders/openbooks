/**
 * Localizable sentence templates for utilization (Billable IQ).
 *
 * `utilizationStrings(t)` builds the bundle from `getTranslations('analytics')`
 * in the request locale. The history-period labels reuse the shared month
 * template; alert thresholds travel as numbers and pre-formatted money
 * travels as strings.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";


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
  /** `hours` renders through the catalog ICU number formatter. */
  alertUnratedHours(hours: number): UtilizationAlert;
}

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
    alertUnratedHours: (hours) => ({ type: "warning", message: t("utilization.alerts.unratedHours", { hours }) }),
  };
}
