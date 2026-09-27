/**
 * Localizable sentence templates for True Cost (rate-engine scenario
 * insights, formula error, category/profile display names, month labels).
 *
 * `trueCostStrings(t)` builds the bundle from `getTranslations('analytics')`
 * in the request locale. Counts travel as numbers into ICU plurals;
 * pre-formatted money travels as strings.
 *
 * The static ALLOCATION_BASES / ALLOCATION_METHODS / RATE_FORMATS /
 * COMPOSITE_METHODS tables in true-cost-engine.ts stay the English key
 * registry (RATIO_DEFS precedent): the hub client renders its own catalog
 * keys (`trueCost.bases.*`, `trueCost.allocation.*`) and the config API only
 * reads the table keys for validation, so the table labels render nowhere.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";


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
