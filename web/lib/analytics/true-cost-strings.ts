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


/**
 * Rate-format keys the refusal messages name. The engine blends display
 * rates, so a mixed-unit refusal must show the translated labels
 * (`Currency/Hour`, not `per_hour`).
 */
const RATE_FORMAT_CATALOG_KEY: Record<string, string> = {
  per_hour: "perHour",
  percent_labor: "percentLabor",
  percent_cost: "percentCost",
  per_fte: "perFte",
  per_unit: "perUnit",
};

export interface TrueCostStrings {
  locale: string;
  /** Presentation currency code bound into `{currency}` catalog slots. */
  currency: string;
  monthLabel(ym: string): string;
  /** Map the SQL `coalesce(…, 'Unknown')` sentinel to the request language. */
  displayEmployeeName(name: string): string;
  /** Map the seeded `DEFAULT_PROFILE` display name to the request language. */
  displayProfileName(name: string): string;
  /** Native non-billable-time burden category name. */
  timeCategoryName: string;
  /** Translated rate-format label for refusal messages (`per_hour` never leaks). */
  rateFormatLabel(format: string): string;
  /** Translated allocation-base label for refusal messages. */
  allocationBaseLabel(base: string): string;
  /** Composite/KPI-level refusals: the composite cannot blend, but every
   * category and editor still renders. Each names the remedy that exists. */
  refusalMixedUnits(formats: string, categories: string): string;
  refusalCascadingNoLabor(): string;
  refusalCascadingNoLaborDept(dept: string): string;
  refusalPerFteNoHours(category: string): string;
  refusalPerFteNoHoursDept(category: string, dept: string): string;
  refusalMissingBase(category: string, format: string, base: string): string;
  refusalFormulaReference(category: string, reference: string): string;
  refusalFormulaNegative(category: string, amount: string): string;
  refusalUnreadableAmount(category: string): string;
  /** Formula-category evaluation failure note. */
  formulaError: string;
  /** Absorption refused: no overhead application account is configured. */
  absorptionNoAccount: string;
  /** Absorption refused under a net-zero-pair application with no applied
   * postings and no cards: approve project time (approvals carry overhead)
   * or Backfill in Setup → Overhead Model. */
  absorptionNoPostings: string;
  /** Absorption refused with no applied postings and no published cards:
   * publish standard rates in Setup → Overhead Model. */
  absorptionNoCards: string;
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
export function trueCostStrings(t: CatalogMessageFn, locale: string, currency = "USD"): TrueCostStrings {
  return {
    locale,
    currency,
    monthLabel: catalogMonthLabel(t),
    displayEmployeeName: (name) => (name === "Unknown" ? t("trueCost.labels.unknownEmployee") : name),
    displayProfileName: (name) => (name === "Default" ? t("trueCost.labels.defaultProfile") : name),
    timeCategoryName: t("trueCost.labels.timeCategory"),
    rateFormatLabel: (format) => t(`trueCost.allocation.${RATE_FORMAT_CATALOG_KEY[format] ?? format}`, { currency }),
    allocationBaseLabel: (base) => t(`trueCost.bases.${base}`),
    refusalMixedUnits: (formats, categories) => t("trueCost.refusals.mixedUnits", { formats, categories }),
    refusalCascadingNoLabor: () => t("trueCost.refusals.cascadingNoLabor"),
    refusalCascadingNoLaborDept: (dept) => t("trueCost.refusals.cascadingNoLaborDept", { dept }),
    refusalPerFteNoHours: (category) => t("trueCost.refusals.perFteNoHours", { category }),
    refusalPerFteNoHoursDept: (category, dept) => t("trueCost.refusals.perFteNoHoursDept", { category, dept }),
    refusalMissingBase: (category, format, base) => t("trueCost.refusals.missingBase", { category, format, base }),
    refusalFormulaReference: (category, reference) => t("trueCost.refusals.formulaReference", { category, reference }),
    refusalFormulaNegative: (category, amount) => t("trueCost.refusals.formulaNegative", { category, amount }),
    refusalUnreadableAmount: (category) => t("trueCost.refusals.unreadableAmount", { category }),
    formulaError: t("trueCost.labels.formulaError"),
    absorptionNoAccount: t("trueCost.labels.absorptionNoAccount"),
    absorptionNoPostings: t("trueCost.labels.absorptionNoPostings"),
    absorptionNoCards: t("trueCost.labels.absorptionNoCards"),
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
