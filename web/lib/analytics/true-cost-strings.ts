/**
 * Localizable sentence templates for True Cost (rate-engine scenario
 * insights, formula error, category/profile display names, month labels).
 *
 * Same pattern as the other analytics bundles: `englishTrueCostStrings` is
 * the exact legacy English copy (direct callers keep byte-identical output);
 * `trueCostStrings(t)` builds the catalog-backed bundle from
 * `getTranslations('analytics')` in the request locale. Counts travel as
 * numbers into ICU plurals (no more `employee(s)` hacks); pre-formatted
 * money travels as strings.
 *
 * The static ALLOCATION_BASES / ALLOCATION_METHODS / RATE_FORMATS /
 * COMPOSITE_METHODS tables in true-cost-engine.ts stay the English key
 * registry (RATIO_DEFS precedent): the hub client renders its own catalog
 * keys (`trueCost.bases.*`, `trueCost.allocation.*`) and the config API only
 * reads the table keys for validation, so the table labels render nowhere.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";

/** en-US short month names, Jan→Dec — the exact legacy toLocaleString rendering. */
const LEGACY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface TrueCostStrings {
  locale: string;
  monthLabel(ym: string): string;
  /** Map the SQL `coalesce(…, 'Unknown')` sentinel to the request language. */
  displayEmployeeName(name: string): string;
  /** Map the seeded `DEFAULT_PROFILE` display name to the request language. */
  displayProfileName(name: string): string;
  /** Native non-billable-time burden category name. */
  timeCategoryName: string;
  /** Formula-category evaluation failure note. */
  formulaError: string;
  /** `utilPct` is pre-rendered (legacy toFixed(0)); `hours` is round2. */
  scenarioHire(count: number, utilPct: string, hours: number): string;
  /** `savings` is pre-formatted money; `hours` is round2. */
  scenarioTerminate(count: number, savings: string, hours: number): string;
  /** `hours` is round2 monthly hours. */
  scenarioWinContract(hours: number): string;
  /** `hours` is round2 monthly hours. */
  scenarioLoseContract(hours: number): string;
  /** `amount` is pre-formatted money (absolute value). */
  scenarioCostChange(changeType: "increase" | "decrease", amount: string): string;
  /** Percents are pre-rendered (legacy toFixed(0)). */
  scenarioUtilizationChange(fromPct: string, toPct: string, direction: "up" | "down"): string;
}

/** Exact legacy English sentences (byte-identical to the pre-catalog engine). */
export const englishTrueCostStrings: TrueCostStrings = {
  locale: "en",
  monthLabel: (ym) => {
    // Static table, never a Date: the label only reads the month name and the
    // year suffix from the parsed numbers, so output is identical at every year.
    const [y, m] = ym.split("-").map(Number);
    return `${LEGACY_MONTHS[((m ?? 1) - 1 + 12) % 12] ?? ym} '${String(y ?? "").slice(2)}`;
  },
  displayEmployeeName: (name) => name,
  displayProfileName: (name) => name,
  timeCategoryName: "Non-Billable Time",
  formulaError: "Invalid formula result",
  scenarioHire: (count, utilPct, hours) =>
    `Adding ${count} employee(s) at ${utilPct}% utilization adds ${hours} monthly billable hours.`,
  scenarioTerminate: (count, savings, hours) =>
    `Reducing ${count} employee(s) saves ${savings} in overhead but loses ${hours} billable hours.`,
  scenarioWinContract: (hours) =>
    `Winning contract adds ${hours} monthly hours, spreading overhead across more volume.`,
  scenarioLoseContract: (hours) =>
    `Losing contract removes ${hours} monthly hours, concentrating overhead on fewer hours.`,
  scenarioCostChange: (changeType, amount) =>
    `${changeType === "decrease" ? "Reducing" : "Adding"} ${amount} in overhead costs.`,
  scenarioUtilizationChange: (fromPct, toPct, direction) =>
    `Changing utilization from ${fromPct}% to ${toPct}% ${direction === "up" ? "increases" : "decreases"} billable hours.`,
};

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function trueCostStrings(t: CatalogMessageFn, locale: string): TrueCostStrings {
  return {
    locale,
    monthLabel: catalogMonthLabel(t),
    displayEmployeeName: (name) => (name === "Unknown" ? t("trueCost.labels.unknownEmployee") : name),
    displayProfileName: (name) => (name === "Default" ? t("trueCost.labels.defaultProfile") : name),
    timeCategoryName: t("trueCost.labels.timeCategory"),
    formulaError: t("trueCost.labels.formulaError"),
    scenarioHire: (count, utilPct, hours) =>
      t("trueCost.scenarios.hire", { count, util: utilPct, hours }),
    scenarioTerminate: (count, savings, hours) =>
      t("trueCost.scenarios.terminate", { count, savings, hours }),
    scenarioWinContract: (hours) => t("trueCost.scenarios.winContract", { hours }),
    scenarioLoseContract: (hours) => t("trueCost.scenarios.loseContract", { hours }),
    scenarioCostChange: (changeType, amount) =>
      t("trueCost.scenarios.costChange", { direction: changeType, amount }),
    scenarioUtilizationChange: (fromPct, toPct, direction) =>
      t("trueCost.scenarios.utilizationChange", { from: fromPct, to: toPct, direction }),
  };
}
