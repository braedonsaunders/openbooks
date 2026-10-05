import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import { moneyRefusal } from "../payroll-decimal-refusal";
import { normalizeMoney } from "@openbooks/engine/money";

/**
 * The single specification of every editable analytics threshold.
 *
 * One spec feeds every surface: the Configuration editors render it (served
 * by GET /api/analytics/config/<dashboard>), the PUT validates against it,
 * and the dashboard loaders read effective values through it. No view keeps
 * its own copy of a field list or a default.
 *
 * Kinds decide storage, validation and presentation:
 * - `number` / `percent`: a plain number inside [min, max]; percent values are
 *   percentage points (40 = 40%).
 * - `money`: an exact decimal string in the organization's presentation
 *   currency. The editor labels it with that currency's code and the save
 *   records which currency the amounts were entered in. A money field may be
 *   `optional`, stored as "" when unset: a reader of an unset amount must
 *   refuse by name, never substitute a figure.
 * - `toggle`: 0 or 1.
 * - `select`: one of the declared option codes.
 *
 * `ordered` lists threshold ladders whose values must strictly ascend
 * (medium < high < critical); a save that would make a level unreachable is
 * refused by name.
 *
 * Labels live in the message catalog: `labelKey` and `helpKey` are full
 * catalog paths, rendered with `{currency}` bound to the presentation
 * currency code.
 *
 * This module is pure so the editor, the API route and the loaders share it.
 */

export type ConfigFieldKind = "number" | "percent" | "money" | "toggle" | "select";

export interface ConfigField {
  key: string;
  kind: ConfigFieldKind;
  labelKey: string;
  helpKey: string;
  /** Inclusive bounds for number/percent kinds. */
  min?: number;
  max?: number;
  step?: number;
  /** Inclusive upper bound for money kinds, as an exact decimal string. */
  maxAmount?: string;
  /** Money only: "" (unset) is a valid stored value. */
  optional?: boolean;
  /** Select only: the allowed option codes, each labelled at `${optionsKey}.<code>`. */
  options?: readonly string[];
  optionsKey?: string;
}

export type AnalyticsConfigValue = number | string;
export type AnalyticsConfigValues = Record<string, AnalyticsConfigValue>;

export interface AnalyticsConfigSpec {
  /** Analytics catalog slug whose permission and feature gate govern this config. */
  slug: string;
  fields: ConfigField[];
  defaults: AnalyticsConfigValues;
  ordered?: readonly (readonly string[])[];
  /**
   * Sections the editor renders, in order, each a catalog heading and the
   * fields under it. Fields in no section render last, without a heading.
   */
  groups?: readonly { labelKey: string; fields: readonly string[] }[];
}

const pct = (key: string, labelKey: string, min = 0, max = 100, step = 1): ConfigField => ({
  key, kind: "percent", labelKey: `${labelKey}.label`, helpKey: `${labelKey}.help`, min, max, step,
});
const num = (key: string, labelKey: string, min: number, max: number, step = 1): ConfigField => ({
  key, kind: "number", labelKey: `${labelKey}.label`, helpKey: `${labelKey}.help`, min, max, step,
});

export const ANALYTICS_CONFIG = {
  financialHealth: {
    slug: "financial-health",
    // Starting targets an organization replaces with its own industry's.
    // Money benchmarks have no currency-neutral starting value, so they start
    // unset and those ratios show ungraded until the organization sets them.
    defaults: {
      grossMarginTarget: 40,
      operatingMarginTarget: 15,
      ebitdaMarginTarget: 20,
      netMarginTarget: 10,
      roaTarget: 8,
      roeTarget: 15,
      roicTarget: 12,
      roceTarget: 15,
      currentRatioTarget: 1.5,
      quickRatioTarget: 1,
      debtToEquityTarget: 1,
      liabilitiesToEquityTarget: 2,
      interestCoverageTarget: 5,
      revenuePerEmployee: "",
      gpPerEmployee: "",
      assetTurnoverTarget: 1,
      cogsRatioTarget: 60,
      opexRatioTarget: 25,
      operatingLeverageTarget: 1.5,
      ruleOf40Target: 40,
      gradeDPercent: 60,
      gradeCPercent: 80,
      gradeBPercent: 100,
      gradeAPercent: 120,
      scoreAverage: 40,
      scoreGood: 60,
      scoreExcellent: 80,
      insightCriticalPercent: 50,
      insightWarningPercent: 75,
      revenueDeclineAlertPercent: 15,
      revenueTrendAlertPercent: 10,
      marginCompressionPoints: 3,
      breakevenSafetyPercent: 10,
      anomalySigma: 2,
    },
    fields: [
      pct("grossMarginTarget", "analytics.financialHealth.config.fields.grossMarginTarget"),
      pct("operatingMarginTarget", "analytics.financialHealth.config.fields.operatingMarginTarget"),
      pct("ebitdaMarginTarget", "analytics.financialHealth.config.fields.ebitdaMarginTarget"),
      pct("netMarginTarget", "analytics.financialHealth.config.fields.netMarginTarget"),
      pct("roaTarget", "analytics.financialHealth.config.fields.roaTarget"),
      pct("roeTarget", "analytics.financialHealth.config.fields.roeTarget"),
      pct("roicTarget", "analytics.financialHealth.config.fields.roicTarget"),
      pct("roceTarget", "analytics.financialHealth.config.fields.roceTarget"),
      num("currentRatioTarget", "analytics.financialHealth.config.fields.currentRatioTarget", 0.1, 20, 0.1),
      num("quickRatioTarget", "analytics.financialHealth.config.fields.quickRatioTarget", 0.1, 20, 0.1),
      num("debtToEquityTarget", "analytics.financialHealth.config.fields.debtToEquityTarget", 0.1, 20, 0.1),
      num("liabilitiesToEquityTarget", "analytics.financialHealth.config.fields.liabilitiesToEquityTarget", 0.1, 50, 0.1),
      num("interestCoverageTarget", "analytics.financialHealth.config.fields.interestCoverageTarget", 0.1, 100, 0.1),
      { key: "revenuePerEmployee", kind: "money", optional: true, labelKey: "analytics.financialHealth.config.fields.revenuePerEmployee.label", helpKey: "analytics.financialHealth.config.fields.revenuePerEmployee.help", maxAmount: "100000000000" },
      { key: "gpPerEmployee", kind: "money", optional: true, labelKey: "analytics.financialHealth.config.fields.gpPerEmployee.label", helpKey: "analytics.financialHealth.config.fields.gpPerEmployee.help", maxAmount: "100000000000" },
      num("assetTurnoverTarget", "analytics.financialHealth.config.fields.assetTurnoverTarget", 0.1, 50, 0.1),
      pct("cogsRatioTarget", "analytics.financialHealth.config.fields.cogsRatioTarget", 1, 100),
      pct("opexRatioTarget", "analytics.financialHealth.config.fields.opexRatioTarget", 1, 100),
      num("operatingLeverageTarget", "analytics.financialHealth.config.fields.operatingLeverageTarget", 0.1, 20, 0.1),
      num("ruleOf40Target", "analytics.financialHealth.config.fields.ruleOf40Target", 1, 200),
      pct("gradeDPercent", "analytics.financialHealth.config.fields.gradeDPercent", 1, 500),
      pct("gradeCPercent", "analytics.financialHealth.config.fields.gradeCPercent", 1, 500),
      pct("gradeBPercent", "analytics.financialHealth.config.fields.gradeBPercent", 1, 500),
      pct("gradeAPercent", "analytics.financialHealth.config.fields.gradeAPercent", 1, 500),
      num("scoreAverage", "analytics.financialHealth.config.fields.scoreAverage", 1, 100),
      num("scoreGood", "analytics.financialHealth.config.fields.scoreGood", 1, 100),
      num("scoreExcellent", "analytics.financialHealth.config.fields.scoreExcellent", 1, 100),
      pct("insightCriticalPercent", "analytics.financialHealth.config.fields.insightCriticalPercent", 1, 100),
      pct("insightWarningPercent", "analytics.financialHealth.config.fields.insightWarningPercent", 1, 100),
      pct("revenueDeclineAlertPercent", "analytics.financialHealth.config.fields.revenueDeclineAlertPercent", 1, 100),
      pct("revenueTrendAlertPercent", "analytics.financialHealth.config.fields.revenueTrendAlertPercent", 1, 100),
      num("marginCompressionPoints", "analytics.financialHealth.config.fields.marginCompressionPoints", 0.1, 50, 0.1),
      pct("breakevenSafetyPercent", "analytics.financialHealth.config.fields.breakevenSafetyPercent", 1, 100),
      num("anomalySigma", "analytics.financialHealth.config.fields.anomalySigma", 1, 6, 0.1),
    ],
    ordered: [
      ["gradeDPercent", "gradeCPercent", "gradeBPercent", "gradeAPercent"],
      ["scoreAverage", "scoreGood", "scoreExcellent"],
      ["insightCriticalPercent", "insightWarningPercent"],
    ],
    groups: [
      { labelKey: "analytics.financialHealth.config.groups.profitability", fields: ["grossMarginTarget", "operatingMarginTarget", "ebitdaMarginTarget", "netMarginTarget", "roaTarget", "roeTarget", "roicTarget", "roceTarget"] },
      { labelKey: "analytics.financialHealth.config.groups.liquiditySolvency", fields: ["currentRatioTarget", "quickRatioTarget", "debtToEquityTarget", "liabilitiesToEquityTarget", "interestCoverageTarget"] },
      { labelKey: "analytics.financialHealth.config.groups.efficiencyOperating", fields: ["revenuePerEmployee", "gpPerEmployee", "assetTurnoverTarget", "cogsRatioTarget", "opexRatioTarget", "operatingLeverageTarget", "ruleOf40Target"] },
      { labelKey: "analytics.financialHealth.config.groups.grading", fields: ["gradeDPercent", "gradeCPercent", "gradeBPercent", "gradeAPercent", "scoreAverage", "scoreGood", "scoreExcellent"] },
      { labelKey: "analytics.financialHealth.config.groups.findings", fields: ["insightCriticalPercent", "insightWarningPercent", "revenueDeclineAlertPercent", "revenueTrendAlertPercent", "marginCompressionPoints", "breakevenSafetyPercent", "anomalySigma"] },
    ],
  },
  customerIntelligence: {
    slug: "customer-intelligence",
    defaults: {
      churnCriticalScore: 70,
      churnHighScore: 50,
      churnMediumScore: 30,
      hhiWarning: 1500,
      hhiCritical: 2500,
      clvYears: 3,
    },
    fields: [
      num("churnCriticalScore", "analytics.customer.config.fields.churnCritical", 1, 100),
      num("churnHighScore", "analytics.customer.config.fields.churnHigh", 1, 100),
      num("churnMediumScore", "analytics.customer.config.fields.churnMedium", 1, 100),
      num("hhiWarning", "analytics.customer.config.fields.hhiWarning", 0, 10_000, 100),
      num("hhiCritical", "analytics.customer.config.fields.hhiCritical", 0, 10_000, 100),
      num("clvYears", "analytics.customer.config.fields.clvYears", 1, 10),
    ],
    ordered: [["churnMediumScore", "churnHighScore", "churnCriticalScore"], ["hhiWarning", "hhiCritical"]],
  },
  utilization: {
    slug: "utilization",
    defaults: { targetBillablePct: 70, costSpikeThreshold: 1000, minHours: 10 },
    fields: [
      pct("targetBillablePct", "analytics.utilization.config.fields.targetBillable", 10, 100),
      num("costSpikeThreshold", "analytics.utilization.config.fields.costSpike", 0, 1_000_000, 100),
      num("minHours", "analytics.utilization.config.fields.minHours", 0, 500),
    ],
  },
  vendorPerformance: {
    slug: "vendor-performance",
    defaults: {
      gradeA: 85,
      gradeB: 70,
      gradeC: 55,
      gradeD: 40,
      tierStrategicPct: 10,
      tierCorePct: 30,
      tierTacticalPct: 60,
      significanceStrategic: 40,
      significanceCore: 30,
      significanceTactical: 20,
      significanceTail: 10,
      engagementCapBills: 12,
      neutralStabilityScore: 15,
      highSpendPercentile: 80,
      highPerformanceScore: 75,
      hhiWarning: 1500,
      hhiCritical: 2500,
      onTimeGoodRate: 60,
      slowPayDays: 45,
    },
    fields: [
      num("gradeA", "analytics.vendor.config.fields.gradeA", 0, 100),
      num("gradeB", "analytics.vendor.config.fields.gradeB", 0, 100),
      num("gradeC", "analytics.vendor.config.fields.gradeC", 0, 100),
      num("gradeD", "analytics.vendor.config.fields.gradeD", 0, 100),
      pct("tierStrategicPct", "analytics.vendor.config.fields.tierStrategicPct", 0, 100),
      pct("tierCorePct", "analytics.vendor.config.fields.tierCorePct", 0, 100),
      pct("tierTacticalPct", "analytics.vendor.config.fields.tierTacticalPct", 0, 100),
      num("significanceStrategic", "analytics.vendor.config.fields.significanceStrategic", 0, 100),
      num("significanceCore", "analytics.vendor.config.fields.significanceCore", 0, 100),
      num("significanceTactical", "analytics.vendor.config.fields.significanceTactical", 0, 100),
      num("significanceTail", "analytics.vendor.config.fields.significanceTail", 0, 100),
      num("engagementCapBills", "analytics.vendor.config.fields.engagementCapBills", 1, 500),
      num("neutralStabilityScore", "analytics.vendor.config.fields.neutralStabilityScore", 0, 100),
      num("highSpendPercentile", "analytics.vendor.config.fields.highSpendPercentile", 0, 100),
      num("highPerformanceScore", "analytics.vendor.config.fields.highPerformanceScore", 0, 100),
      num("hhiWarning", "analytics.vendor.config.fields.hhiWarning", 0, 10_000, 100),
      num("hhiCritical", "analytics.vendor.config.fields.hhiCritical", 0, 10_000, 100),
      pct("onTimeGoodRate", "analytics.vendor.config.fields.onTimeGoodRate", 0, 100),
      num("slowPayDays", "analytics.vendor.config.fields.slowPayDays", 0, 365),
    ],
    ordered: [["gradeD", "gradeC", "gradeB", "gradeA"], ["tierStrategicPct", "tierCorePct", "tierTacticalPct"], ["hhiWarning", "hhiCritical"]],
  },
  sentinel: {
    slug: "sentinel",
    defaults: { duplicateDays: 14, duplicateMinAmount: 100, sequentialMinCount: 3, sequentialMinDays: 7 },
    fields: [
      num("duplicateDays", "analytics.sentinel.config.fields.duplicateDays", 1, 90),
      num("duplicateMinAmount", "analytics.sentinel.config.fields.duplicateMinAmount", 0, 100_000, 50),
      num("sequentialMinCount", "analytics.sentinel.config.fields.sequentialMinCount", 2, 50),
      num("sequentialMinDays", "analytics.sentinel.config.fields.sequentialMinDays", 1, 365),
    ],
  },
  cashflow: {
    slug: "cashflow",
    // A zero cap means payables are not capacity-scheduled. Zero carries no
    // currency, so the default is meaningful in every presentation currency.
    defaults: { weeklyApCap: "0.0000", restrictToSafe: 0 },
    fields: [
      { key: "weeklyApCap", kind: "money", labelKey: "ap.cockpit.config.weeklyCapLabel", helpKey: "ap.cockpit.config.weeklyCapHelp", maxAmount: "100000000" },
      { key: "restrictToSafe", kind: "toggle", labelKey: "ap.cockpit.config.restrictLabel", helpKey: "ap.cockpit.config.restrictHelp" },
    ],
  },
  spendVelocity: {
    slug: "spend-velocity",
    defaults: {
      velocityHighThreshold: 15,
      velocityMediumThreshold: 5,
      anomalyStdDevThreshold: 2.5,
      anomalyCriticalOffset: 0.5,
      accelStrong: 3,
      accelMild: 1,
      topVendorsCount: 30,
      boilingFrogMonths: 6,
      boilingFrogMinIncrease: 3,
      boilingFrogStepCap: 10,
      boilingFrogMonotonicRatio: 50,
      boilingFrogWarningCreep: 10,
      boilingFrogCriticalCreep: 20,
      zombieMinMonths: 6,
      zombieMaxDeviation: 1,
      zombieCriticalMonths: 12,
      fragmentationMinTxns: 20,
      fragmentationMaxAvgSize: "",
      fragmentationHighTxns: 50,
      minBaseAmount: "",
      seasonalBand: 15,
      seasonalCriticalDeviation: 50,
      hhiWarning: 1500,
      hhiCritical: 2500,
      concentrationShareThreshold: 5,
      concentrationHighShare: 30,
      concentrationTop1Warning: 25,
      cliffWarningGap: 10,
      cliffCriticalGap: 20,
      cliffWarningRatio: 1.2,
      cliffCriticalRatio: 1.5,
      cliffWarningPoints: 3,
      cliffCriticalPoints: 6,
      projectionCapAccount: 50,
      projectionCapTotal: 30,
      categoryIncreaseThreshold: 10,
      spenderIncreaseThreshold: 20,
      highVelocityAlert: 20,
      typeImbalanceGap: 20,
      opexRatioAlert: 50,
      alertBannerThreshold: 5,
      accountFilterChange: 5,
      accountFilterHighVel: 10,
      healthGradeA: 90,
      healthGradeB: 80,
      healthGradeC: 70,
      healthGradeD: 60,
      healthVelocityCap: 20,
      healthVelocityUnit: 1.5,
      healthVelocityUnitCap: 10,
      healthCriticalCap: 25,
      healthCriticalAnomalyUnit: 4,
      healthCriticalAnomalyCap: 12,
      healthCriticalFrogUnit: 3,
      healthCriticalFrogCap: 8,
      healthCriticalZombieUnit: 2,
      healthCriticalZombieCap: 5,
      healthWarningCap: 15,
      healthWarningAnomalyUnit: 1.5,
      healthWarningAnomalyCap: 6,
      healthWarningFrogUnit: 1,
      healthWarningFrogCap: 4,
      healthWarningZombieUnit: 1,
      healthWarningZombieCap: 3,
      healthStructuralCap: 15,
      structuralTop1High: 30,
      structuralTop1Medium: 25,
      structuralTop1Low: 20,
      structuralTop1HighPoints: 5,
      structuralTop1MediumPoints: 3,
      structuralTop1LowPoints: 1,
      fragmentationUnitWeight: 0.5,
      fragmentationUnitCap: 4,
      savingsRatioWatch: 0.5,
      savingsRatioLow: 1,
      savingsRatioMedium: 2,
      savingsRatioHigh: 3,
      savingsRatioCritical: 5,
      savingsWatchPoints: 1,
      savingsLowPoints: 3,
      savingsMediumPoints: 5,
      savingsHighPoints: 7,
      savingsCriticalPoints: 10,
    },
    fields: [
      pct("velocityHighThreshold", "analytics.spendVelocity.config.fields.highVelocity", 1, 100),
      pct("velocityMediumThreshold", "analytics.spendVelocity.config.fields.mediumVelocity", 0, 50),
      num("anomalyStdDevThreshold", "analytics.spendVelocity.config.fields.anomalySigma", 1, 6, 0.1),
      num("anomalyCriticalOffset", "analytics.spendVelocity.config.fields.anomalyCriticalOffset", 0, 5, 0.1),
      num("accelStrong", "analytics.spendVelocity.config.fields.accelStrong", 0, 20, 0.5),
      num("accelMild", "analytics.spendVelocity.config.fields.accelMild", 0, 20, 0.5),
      num("topVendorsCount", "analytics.spendVelocity.config.fields.topVendorsCount", 1, 200),
      num("boilingFrogMonths", "analytics.spendVelocity.config.fields.boilingFrogMonths", 3, 24),
      num("boilingFrogMinIncrease", "analytics.spendVelocity.config.fields.boilingFrogMinIncrease", 0, 100, 0.5),
      num("boilingFrogStepCap", "analytics.spendVelocity.config.fields.boilingFrogStepCap", 0, 100, 0.5),
      num("boilingFrogMonotonicRatio", "analytics.spendVelocity.config.fields.boilingFrogMonotonicRatio", 0, 100),
      num("boilingFrogWarningCreep", "analytics.spendVelocity.config.fields.boilingFrogWarningCreep", 0, 500),
      num("boilingFrogCriticalCreep", "analytics.spendVelocity.config.fields.boilingFrogCriticalCreep", 0, 500),
      num("zombieMinMonths", "analytics.spendVelocity.config.fields.zombieMonths", 3, 24),
      num("zombieMaxDeviation", "analytics.spendVelocity.config.fields.zombieMaxDeviation", 0, 10, 0.1),
      num("zombieCriticalMonths", "analytics.spendVelocity.config.fields.zombieCriticalMonths", 1, 60),
      num("fragmentationMinTxns", "analytics.spendVelocity.config.fields.fragmentationTxns", 5, 500, 5),
      { key: "fragmentationMaxAvgSize", kind: "money", labelKey: "analytics.spendVelocity.config.fields.fragmentationAvgSize.label", helpKey: "analytics.spendVelocity.config.fields.fragmentationAvgSize.help", maxAmount: "100000000", optional: true },
      num("fragmentationHighTxns", "analytics.spendVelocity.config.fields.fragmentationHighTxns", 5, 500, 5),
      { key: "minBaseAmount", kind: "money", labelKey: "analytics.spendVelocity.config.fields.minBaseAmount.label", helpKey: "analytics.spendVelocity.config.fields.minBaseAmount.help", maxAmount: "100000000", optional: true },
      num("seasonalBand", "analytics.spendVelocity.config.fields.seasonalBand", 0, 100),
      num("seasonalCriticalDeviation", "analytics.spendVelocity.config.fields.seasonalCriticalDeviation", 0, 100),
      num("hhiWarning", "analytics.spendVelocity.config.fields.hhiWarning", 0, 10_000, 100),
      num("hhiCritical", "analytics.spendVelocity.config.fields.hhiCritical", 0, 10_000, 100),
      num("concentrationShareThreshold", "analytics.spendVelocity.config.fields.concentrationShareThreshold", 0, 100, 0.5),
      num("concentrationHighShare", "analytics.spendVelocity.config.fields.concentrationHighShare", 0, 100, 0.5),
      num("concentrationTop1Warning", "analytics.spendVelocity.config.fields.concentrationTop1Warning", 0, 100),
      num("cliffWarningGap", "analytics.spendVelocity.config.fields.cliffWarningGap", 0, 200),
      num("cliffCriticalGap", "analytics.spendVelocity.config.fields.cliffCriticalGap", 0, 200),
      num("cliffWarningRatio", "analytics.spendVelocity.config.fields.cliffWarningRatio", 0, 10, 0.1),
      num("cliffCriticalRatio", "analytics.spendVelocity.config.fields.cliffCriticalRatio", 0, 10, 0.1),
      num("cliffWarningPoints", "analytics.spendVelocity.config.fields.cliffWarningPoints", 0, 25),
      num("cliffCriticalPoints", "analytics.spendVelocity.config.fields.cliffCriticalPoints", 0, 25),
      num("projectionCapAccount", "analytics.spendVelocity.config.fields.projectionCapAccount", 0, 100),
      num("projectionCapTotal", "analytics.spendVelocity.config.fields.projectionCapTotal", 0, 100),
      num("categoryIncreaseThreshold", "analytics.spendVelocity.config.fields.categoryIncreaseThreshold", 0, 1000),
      num("spenderIncreaseThreshold", "analytics.spendVelocity.config.fields.spenderIncreaseThreshold", 0, 1000),
      num("highVelocityAlert", "analytics.spendVelocity.config.fields.highVelocityAlert", 0, 200),
      num("typeImbalanceGap", "analytics.spendVelocity.config.fields.typeImbalanceGap", 0, 200),
      num("opexRatioAlert", "analytics.spendVelocity.config.fields.opexRatioAlert", 0, 100),
      num("alertBannerThreshold", "analytics.spendVelocity.config.fields.alertBannerThreshold", 0, 100),
      num("accountFilterChange", "analytics.spendVelocity.config.fields.accountFilterChange", 0, 100),
      num("accountFilterHighVel", "analytics.spendVelocity.config.fields.accountFilterHighVel", 0, 200),
      num("healthGradeA", "analytics.spendVelocity.config.fields.healthGradeA", 0, 100),
      num("healthGradeB", "analytics.spendVelocity.config.fields.healthGradeB", 0, 100),
      num("healthGradeC", "analytics.spendVelocity.config.fields.healthGradeC", 0, 100),
      num("healthGradeD", "analytics.spendVelocity.config.fields.healthGradeD", 0, 100),
      num("healthVelocityCap", "analytics.spendVelocity.config.fields.healthVelocityCap", 0, 100),
      num("healthVelocityUnit", "analytics.spendVelocity.config.fields.healthVelocityUnit", 0, 10, 0.5),
      num("healthVelocityUnitCap", "analytics.spendVelocity.config.fields.healthVelocityUnitCap", 0, 50),
      num("healthCriticalCap", "analytics.spendVelocity.config.fields.healthCriticalCap", 0, 100),
      num("healthCriticalAnomalyUnit", "analytics.spendVelocity.config.fields.healthCriticalAnomalyUnit", 0, 20, 0.5),
      num("healthCriticalAnomalyCap", "analytics.spendVelocity.config.fields.healthCriticalAnomalyCap", 0, 50),
      num("healthCriticalFrogUnit", "analytics.spendVelocity.config.fields.healthCriticalFrogUnit", 0, 20, 0.5),
      num("healthCriticalFrogCap", "analytics.spendVelocity.config.fields.healthCriticalFrogCap", 0, 50),
      num("healthCriticalZombieUnit", "analytics.spendVelocity.config.fields.healthCriticalZombieUnit", 0, 20, 0.5),
      num("healthCriticalZombieCap", "analytics.spendVelocity.config.fields.healthCriticalZombieCap", 0, 50),
      num("healthWarningCap", "analytics.spendVelocity.config.fields.healthWarningCap", 0, 100),
      num("healthWarningAnomalyUnit", "analytics.spendVelocity.config.fields.healthWarningAnomalyUnit", 0, 20, 0.5),
      num("healthWarningAnomalyCap", "analytics.spendVelocity.config.fields.healthWarningAnomalyCap", 0, 50),
      num("healthWarningFrogUnit", "analytics.spendVelocity.config.fields.healthWarningFrogUnit", 0, 20, 0.5),
      num("healthWarningFrogCap", "analytics.spendVelocity.config.fields.healthWarningFrogCap", 0, 50),
      num("healthWarningZombieUnit", "analytics.spendVelocity.config.fields.healthWarningZombieUnit", 0, 20, 0.5),
      num("healthWarningZombieCap", "analytics.spendVelocity.config.fields.healthWarningZombieCap", 0, 50),
      num("healthStructuralCap", "analytics.spendVelocity.config.fields.healthStructuralCap", 0, 100),
      num("structuralTop1High", "analytics.spendVelocity.config.fields.structuralTop1High", 0, 100),
      num("structuralTop1Medium", "analytics.spendVelocity.config.fields.structuralTop1Medium", 0, 100),
      num("structuralTop1Low", "analytics.spendVelocity.config.fields.structuralTop1Low", 0, 100),
      num("structuralTop1HighPoints", "analytics.spendVelocity.config.fields.structuralTop1HighPoints", 0, 25),
      num("structuralTop1MediumPoints", "analytics.spendVelocity.config.fields.structuralTop1MediumPoints", 0, 25),
      num("structuralTop1LowPoints", "analytics.spendVelocity.config.fields.structuralTop1LowPoints", 0, 25),
      num("fragmentationUnitWeight", "analytics.spendVelocity.config.fields.fragmentationUnitWeight", 0, 5, 0.1),
      num("fragmentationUnitCap", "analytics.spendVelocity.config.fields.fragmentationUnitCap", 0, 25),
      num("savingsRatioWatch", "analytics.spendVelocity.config.fields.savingsRatioWatch", 0, 100, 0.1),
      num("savingsRatioLow", "analytics.spendVelocity.config.fields.savingsRatioLow", 0, 100, 0.1),
      num("savingsRatioMedium", "analytics.spendVelocity.config.fields.savingsRatioMedium", 0, 100, 0.1),
      num("savingsRatioHigh", "analytics.spendVelocity.config.fields.savingsRatioHigh", 0, 100, 0.1),
      num("savingsRatioCritical", "analytics.spendVelocity.config.fields.savingsRatioCritical", 0, 100, 0.1),
      num("savingsWatchPoints", "analytics.spendVelocity.config.fields.savingsWatchPoints", 0, 25),
      num("savingsLowPoints", "analytics.spendVelocity.config.fields.savingsLowPoints", 0, 25),
      num("savingsMediumPoints", "analytics.spendVelocity.config.fields.savingsMediumPoints", 0, 25),
      num("savingsHighPoints", "analytics.spendVelocity.config.fields.savingsHighPoints", 0, 25),
      num("savingsCriticalPoints", "analytics.spendVelocity.config.fields.savingsCriticalPoints", 0, 25),
    ],
    ordered: [
      ["velocityMediumThreshold", "velocityHighThreshold"],
      ["boilingFrogWarningCreep", "boilingFrogCriticalCreep"],
      ["hhiWarning", "hhiCritical"],
      ["cliffWarningGap", "cliffCriticalGap"],
      ["cliffWarningRatio", "cliffCriticalRatio"],
      ["healthGradeD", "healthGradeC", "healthGradeB", "healthGradeA"],
      ["accelMild", "accelStrong"],
      ["structuralTop1Low", "structuralTop1Medium", "structuralTop1High"],
      ["savingsRatioWatch", "savingsRatioLow", "savingsRatioMedium", "savingsRatioHigh", "savingsRatioCritical"],
    ],
  },
} satisfies Record<string, AnalyticsConfigSpec>;

export type AnalyticsDashboard = keyof typeof ANALYTICS_CONFIG;

/** Effective values of one dashboard, typed from its declared defaults. */
export type ConfigValuesOf<D extends AnalyticsDashboard> = (typeof ANALYTICS_CONFIG)[D]["defaults"];

export type CashflowConfig = ConfigValuesOf<"cashflow">;

export function isAnalyticsDashboard(value: string): value is AnalyticsDashboard {
  return Object.prototype.hasOwnProperty.call(ANALYTICS_CONFIG, value);
}

export function analyticsConfigSpec(dashboard: AnalyticsDashboard): AnalyticsConfigSpec {
  return ANALYTICS_CONFIG[dashboard];
}

/** Sibling key recording the currency the dashboard's money fields were saved in. */
export function configCurrencyKey(dashboard: string): string {
  return `${dashboard}Currency`;
}

function storedMoney(field: ConfigField, raw: unknown): string | null {
  if (raw === "" && field.optional) return "";
  const exact = canonicalDecimal(typeof raw === "number" ? String(raw) : raw, 4);
  if (exact === null || compareDecimal(exact, "0") < 0) return null;
  if (field.maxAmount && compareDecimal(exact, field.maxAmount) > 0) return null;
  return normalizeMoney(exact);
}

/**
 * Tolerant READ of a stored blob: each value is checked against its field and
 * an unreadable or out-of-range entry keeps the field's default, so a
 * hand-edited settings blob can never break a dashboard. Money entered in a
 * currency other than the current presentation currency is not an amount in
 * that currency: optional money fields read as unset, required ones keep a
 * default only when that default is zero (meaningful in every currency).
 */
export function mergeConfig<D extends AnalyticsDashboard>(
  dashboard: D,
  stored: unknown,
  currency?: { stored: string | null; presentation: string },
): ConfigValuesOf<D> {
  const spec: AnalyticsConfigSpec = ANALYTICS_CONFIG[dashboard];
  const out: AnalyticsConfigValues = { ...spec.defaults };
  const blob = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const currencyMismatch = !!currency?.stored && currency.stored !== currency.presentation;
  for (const field of spec.fields) {
    if (!(field.key in blob)) continue;
    const raw = blob[field.key];
    switch (field.kind) {
      case "money": {
        if (currencyMismatch) {
          if (field.optional) out[field.key] = "";
          continue;
        }
        const value = storedMoney(field, raw);
        if (value !== null) out[field.key] = value;
        break;
      }
      case "toggle":
        if (raw === 0 || raw === 1 || raw === "0" || raw === "1") out[field.key] = Number(raw);
        break;
      case "select":
        if (typeof raw === "string" && field.options?.includes(raw)) out[field.key] = raw;
        break;
      default: {
        const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
        if (Number.isFinite(n) && n >= (field.min ?? -Infinity) && n <= (field.max ?? Infinity)) out[field.key] = n;
      }
    }
  }
  return out as ConfigValuesOf<D>;
}

export class InvalidConfigValue extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidConfigValue";
  }
}

function fieldName(field: ConfigField): string {
  return `'${field.key}'`;
}

function strictNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanValue(field: ConfigField, value: unknown): AnalyticsConfigValue {
  switch (field.kind) {
    case "money": {
      if (value === "" && field.optional) return "";
      if (value === "") {
        throw new InvalidConfigValue(field.key, `threshold ${fieldName(field)} is required — enter an amount (0 or more)`);
      }
      const exact = canonicalDecimal(value, 4);
      if (exact === null) throw new InvalidConfigValue(field.key, moneyRefusal(`threshold ${fieldName(field)}`, value));
      if (compareDecimal(exact, "0") < 0) {
        throw new InvalidConfigValue(field.key, `threshold ${fieldName(field)} must not be negative`);
      }
      if (field.maxAmount && compareDecimal(exact, field.maxAmount) > 0) {
        throw new InvalidConfigValue(field.key, `threshold ${fieldName(field)} must be at most ${field.maxAmount}`);
      }
      return normalizeMoney(exact);
    }
    case "toggle":
      if (value === 0 || value === 1 || value === "0" || value === "1" || value === true || value === false) {
        return value === true ? 1 : value === false ? 0 : Number(value);
      }
      throw new InvalidConfigValue(field.key, `threshold ${fieldName(field)} must be on (1) or off (0)`);
    case "select":
      if (typeof value === "string" && field.options?.includes(value)) return value;
      throw new InvalidConfigValue(
        field.key,
        `threshold ${fieldName(field)} must be one of ${(field.options ?? []).join(", ")}`,
      );
    default: {
      const parsed = strictNumber(value);
      if (parsed === null || parsed < (field.min ?? -Infinity) || parsed > (field.max ?? Infinity)) {
        throw new InvalidConfigValue(
          field.key,
          `threshold ${fieldName(field)} must be a number between ${field.min} and ${field.max} (received ${String(value).slice(0, 60)})`,
        );
      }
      return parsed;
    }
  }
}

function comparable(value: AnalyticsConfigValue): string | null {
  return value === "" ? null : String(value);
}

/**
 * Strict WRITE validation: every field required on each whole-object save,
 * unknown keys refused, each value type- and range-checked, and every ordered
 * ladder strictly ascending — each refusal named. Never the tolerant
 * mergeConfig: that reader exists for legacy blobs, and using it at write
 * would persist something other than what was requested.
 */
export function cleanConfigValues(dashboard: AnalyticsDashboard, raw: unknown): AnalyticsConfigValues {
  const spec: AnalyticsConfigSpec = ANALYTICS_CONFIG[dashboard];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidConfigValue("", `threshold values for the ${dashboard} configuration must be an object of per-threshold values`);
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(spec.fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new InvalidConfigValue(key, `unknown threshold '${key}' for the ${dashboard} configuration — remove it and retry`);
    }
  }
  const out: AnalyticsConfigValues = {};
  for (const field of spec.fields) {
    if (!(field.key in input)) {
      throw new InvalidConfigValue(field.key, `threshold ${fieldName(field)} is required — send every threshold on each save`);
    }
    out[field.key] = cleanValue(field, input[field.key]);
  }
  const byKey = new Map(spec.fields.map((field) => [field.key, field]));
  for (const ladder of spec.ordered ?? []) {
    for (let i = 1; i < ladder.length; i++) {
      const lowField = byKey.get(ladder[i - 1]!)!;
      const highField = byKey.get(ladder[i]!)!;
      const low = comparable(out[lowField.key]!);
      const high = comparable(out[highField.key]!);
      if (low === null || high === null) continue;
      if (compareDecimal(low, high) >= 0) {
        throw new InvalidConfigValue(
          highField.key,
          `threshold ${fieldName(highField)} (${high}) must be greater than ${fieldName(lowField)} (${low}) — otherwise the higher level can never be reached`,
        );
      }
    }
  }
  return out;
}
