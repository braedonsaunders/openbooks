import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import { moneyRefusal } from "../payroll-decimal-refusal";
import { normalizeMoney } from "@openbooks/engine/money";
import { FORECAST_CONFIDENCE_LEVELS } from "./forecast-levels";

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
  /** Number only: whole numbers required — week/day/month counts refuse fractions by name. */
  int?: boolean;
  /** Inclusive upper bound for money kinds, as an exact decimal string. */
  maxAmount?: string;
  /** Money only: "" (unset) is a valid stored value. */
  optional?: boolean;
  /** Select only: the allowed option codes, each labelled at `${optionsKey}.<code>`. */
  options?: readonly string[];
  optionsKey?: string;
  /**
   * Select only: format numeric option codes in the viewer's locale instead
   * of labelling them from the catalog. `"percent"` reads codes as whole
   * percentages (90 renders 90% in English, 90 % in French) so no locale
   * ships a hard-coded % sign. Options using this carry no optionsKey.
   */
  optionsFormat?: "percent";
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
  /**
   * Weight groups that must sum to `total` (percentage points of one
   * composite score). A save breaking a group is refused by name: partial
   * weights would silently rescale every grade the score feeds.
   */
  sumsTo?: readonly { keys: readonly string[]; total: number }[];
}

const pct = (key: string, labelKey: string, min = 0, max = 100, step = 1): ConfigField => ({
  key, kind: "percent", labelKey: `${labelKey}.label`, helpKey: `${labelKey}.help`, min, max, step,
});
const num = (key: string, labelKey: string, min: number, max: number, step = 1, int = false): ConfigField => ({
  key, kind: "number", labelKey: `${labelKey}.label`, helpKey: `${labelKey}.help`, min, max, step,
  ...(int ? { int: true as const } : {}),
});

/**
 * The forecast macro-adjustment options as one table: adding a code here
 * offers it in the threshold editor AND prices it in the loader, so a new
 * option can never throw the dashboard. Factors stay display numbers — the
 * loader applies them to chart coordinates, never ledger money.
 */
export const FORECAST_ADJUSTMENTS: ReadonlyArray<{ code: string; factor: number }> = [
  { code: "neg10", factor: -0.1 },
  { code: "neg05", factor: -0.05 },
  { code: "zero", factor: 0 },
  { code: "pos05", factor: 0.05 },
  { code: "pos10", factor: 0.1 },
];

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
      breakevenComfortPercent: 30,
      forecastMethod: "ets",
      forecastHorizon: "6",
      forecastConfidence: "90",
      forecastSeasonality: "auto",
      forecastAdjustment: "zero",
      forecastEtsAlpha: 0.3,
      forecastEtsBeta: 0.1,
      forecastEtsGamma: 0.2,
      forecastDampedPhi: 0.9,
      forecastMa1: 0.3,
      forecastSeasonalityMinCorr: 0.3,
      forecastSeasonalityMinPeriods: 24,
      budgetOnTrackPercent: 10,
      budgetWatchPercent: 25,
      segmentHhiWarning: 1500,
      segmentHhiCritical: 2500,
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
      pct("breakevenComfortPercent", "analytics.financialHealth.config.fields.breakevenComfortPercent", 1, 100),
      {
        key: "forecastMethod", kind: "select", labelKey: "analytics.financialHealth.config.fields.forecastMethod.label", helpKey: "analytics.financialHealth.config.fields.forecastMethod.help",
        options: ["ets", "ets_damped", "linear", "seasonal", "moving_avg", "arima"], optionsKey: "analytics.financialHealth.config.options.forecastMethod",
      },
      {
        key: "forecastHorizon", kind: "select", labelKey: "analytics.financialHealth.config.fields.forecastHorizon.label", helpKey: "analytics.financialHealth.config.fields.forecastHorizon.help",
        options: ["3", "6", "12", "24"], optionsKey: "analytics.financialHealth.config.options.forecastHorizon",
      },
      {
        key: "forecastConfidence", kind: "select", labelKey: "analytics.financialHealth.config.fields.forecastConfidence.label", helpKey: "analytics.financialHealth.config.fields.forecastConfidence.help",
        // The offered levels are the engine's own band table: a level the
        // model cannot band can never be offered, and a new level is offered
        // everywhere the moment the engine learns it. Labels format in the
        // viewer's locale (percent), never from hard-coded catalog text.
        options: FORECAST_CONFIDENCE_LEVELS.map(String), optionsFormat: "percent",
      },
      {
        key: "forecastSeasonality", kind: "select", labelKey: "analytics.financialHealth.config.fields.forecastSeasonality.label", helpKey: "analytics.financialHealth.config.fields.forecastSeasonality.help",
        options: ["auto", "none", "monthly", "quarterly"], optionsKey: "analytics.financialHealth.config.options.forecastSeasonality",
      },
      // Adjustment codes carry no dots: option labels resolve through the
      // catalog path, which splits on dots, so dotted numbers would not look
      // up. The server maps each code to its exact adjustment factor.
      {
        key: "forecastAdjustment", kind: "select", labelKey: "analytics.financialHealth.config.fields.forecastAdjustment.label", helpKey: "analytics.financialHealth.config.fields.forecastAdjustment.help",
        options: FORECAST_ADJUSTMENTS.map((a) => a.code), optionsKey: "analytics.financialHealth.config.options.forecastAdjustment",
      },
      num("forecastEtsAlpha", "analytics.financialHealth.config.fields.forecastEtsAlpha", 0.05, 0.95, 0.05),
      num("forecastEtsBeta", "analytics.financialHealth.config.fields.forecastEtsBeta", 0.05, 0.95, 0.05),
      num("forecastEtsGamma", "analytics.financialHealth.config.fields.forecastEtsGamma", 0.05, 0.95, 0.05),
      num("forecastDampedPhi", "analytics.financialHealth.config.fields.forecastDampedPhi", 0.5, 1, 0.05),
      num("forecastMa1", "analytics.financialHealth.config.fields.forecastMa1", -0.9, 0.9, 0.05),
      num("forecastSeasonalityMinCorr", "analytics.financialHealth.config.fields.forecastSeasonalityMinCorr", 0, 1, 0.05),
      num("forecastSeasonalityMinPeriods", "analytics.financialHealth.config.fields.forecastSeasonalityMinPeriods", 4, 120, 1),
      pct("budgetOnTrackPercent", "analytics.financialHealth.config.fields.budgetOnTrackPercent", 1, 100),
      pct("budgetWatchPercent", "analytics.financialHealth.config.fields.budgetWatchPercent", 1, 100),
      num("segmentHhiWarning", "analytics.financialHealth.config.fields.segmentHhiWarning", 0, 10_000, 100),
      num("segmentHhiCritical", "analytics.financialHealth.config.fields.segmentHhiCritical", 0, 10_000, 100),
      num("anomalySigma", "analytics.financialHealth.config.fields.anomalySigma", 1, 6, 0.1),
    ],
    ordered: [
      ["gradeDPercent", "gradeCPercent", "gradeBPercent", "gradeAPercent"],
      ["scoreAverage", "scoreGood", "scoreExcellent"],
      ["insightCriticalPercent", "insightWarningPercent"],
      ["breakevenSafetyPercent", "breakevenComfortPercent"],
      ["budgetOnTrackPercent", "budgetWatchPercent"],
      ["segmentHhiWarning", "segmentHhiCritical"],
    ],
    groups: [
      { labelKey: "analytics.financialHealth.config.groups.profitability", fields: ["grossMarginTarget", "operatingMarginTarget", "ebitdaMarginTarget", "netMarginTarget", "roaTarget", "roeTarget", "roicTarget", "roceTarget"] },
      { labelKey: "analytics.financialHealth.config.groups.liquiditySolvency", fields: ["currentRatioTarget", "quickRatioTarget", "debtToEquityTarget", "liabilitiesToEquityTarget", "interestCoverageTarget"] },
      { labelKey: "analytics.financialHealth.config.groups.efficiencyOperating", fields: ["revenuePerEmployee", "gpPerEmployee", "assetTurnoverTarget", "cogsRatioTarget", "opexRatioTarget", "operatingLeverageTarget", "ruleOf40Target"] },
      { labelKey: "analytics.financialHealth.config.groups.grading", fields: ["gradeDPercent", "gradeCPercent", "gradeBPercent", "gradeAPercent", "scoreAverage", "scoreGood", "scoreExcellent"] },
      { labelKey: "analytics.financialHealth.config.groups.budget", fields: ["budgetOnTrackPercent", "budgetWatchPercent"] },
      { labelKey: "analytics.financialHealth.config.groups.segments", fields: ["segmentHhiWarning", "segmentHhiCritical"] },
      { labelKey: "analytics.financialHealth.config.groups.findings", fields: ["insightCriticalPercent", "insightWarningPercent", "revenueDeclineAlertPercent", "revenueTrendAlertPercent", "marginCompressionPoints", "breakevenSafetyPercent", "breakevenComfortPercent", "anomalySigma"] },
      { labelKey: "analytics.financialHealth.config.groups.model", fields: ["forecastMethod", "forecastHorizon", "forecastConfidence", "forecastSeasonality", "forecastAdjustment", "forecastEtsAlpha", "forecastEtsBeta", "forecastEtsGamma", "forecastDampedPhi", "forecastMa1", "forecastSeasonalityMinCorr", "forecastSeasonalityMinPeriods"] },
    ],
  },
  customerIntelligence: {
    slug: "customer-intelligence",
    // The full scoring model, with the values the dashboard always used as
    // defaults. Groups read top to bottom: health weights, intelligence
    // weights, the shared grade ladder, recency bands, churn, CLV, tiers,
    // concentration, friction, payment, profit, nurture, growth.
    defaults: {
      churnCriticalScore: 70,
      churnHighScore: 50,
      churnMediumScore: 30,
      hhiWarning: 1500,
      hhiCritical: 2500,
      clvYears: 3,
      // Health weights: percentage points of the composite health score.
      healthWeightRecency: 25,
      healthWeightFrequency: 25,
      healthWeightMonetary: 30,
      healthWeightPayment: 20,
      // Intelligence weights: percentage points of the portfolio score.
      intelWeightChampions: 30,
      intelWeightRetention: 30,
      intelWeightConcentration: 20,
      intelWeightPayment: 20,
      // ONE grade ladder, shared by the health grade and the intelligence grade.
      gradeAPlus: 90,
      gradeA: 80,
      gradeB: 70,
      gradeC: 60,
      gradeD: 50,
      // RFM recency bands (days since last order).
      recencyGoodDays: 30,
      recencyWarningDays: 90,
      recencyCriticalDays: 180,
      // Churn day thresholds and point increments.
      churnHighDays: 120,
      churnMediumDays: 60,
      churnInactiveLowDays: 30,
      churnInactiveCriticalPoints: 40,
      churnInactiveHighPoints: 25,
      churnInactiveLowPoints: 10,
      churnCadenceHighMultiple: 2,
      churnCadenceLowMultiple: 1.5,
      churnCadenceHighPoints: 30,
      churnCadenceLowPoints: 15,
      churnSingleMaxTxns: 1,
      churnFewMaxTxns: 3,
      churnSinglePoints: 30,
      churnFewPoints: 15,
      // CLV projection: tenure floor, retention curve, retention clamp.
      clvMinYears: 0.25,
      clvRetentionBase: 95,
      clvRetentionDecayDays: 120,
      clvRetentionMinPct: 10,
      clvRetentionMaxPct: 95,
      // CLV tier percentiles (share of ranked customers at or above each tier).
      tierPlatinumPct: 10,
      tierGoldPct: 30,
      tierSilverPct: 60,
      // Concentration share bands (percent of period revenue) and coverage.
      concentrationCriticalShare: 25,
      concentrationHighShare: 15,
      concentrationMediumShare: 10,
      concentrationCoverageShare: 80,
      topSharePct: 10,
      // Concentration health: intelligence points per HHI level. A spread book
      // scores near full marks; a concentrated one drags the portfolio score.
      concentrationHealthHigh: 30,
      concentrationHealthModerate: 60,
      concentrationHealthLow: 90,
      // Velocity urgency: overdue beyond the high multiple of the order cycle
      // reads highly urgent; an order expected within the due-soon days reads
      // as due soon. Past a full cycle overdue is critical by definition.
      velocityUrgencyHighMultiple: 0.5,
      velocityDueSoonDays: 7,
      // Friction: points per credit memo, level point cut-offs, penalty
      // points and issue-rate bands.
      frictionPointsPerCredit: 2,
      frictionCriticalPoints: 10,
      frictionHighPoints: 5,
      frictionMediumPoints: 2,
      frictionPenaltyCritical: 25,
      frictionPenaltyHigh: 15,
      frictionPenaltyMedium: 8,
      frictionCriticalRate: 20,
      frictionHighRate: 10,
      frictionMediumRate: 5,
      // Payment score: DSO bands with penalties, overdue penalty, ratings.
      paymentDsoHighDays: 60,
      paymentDsoHighPenalty: 40,
      paymentDsoMediumDays: 30,
      paymentDsoMediumPenalty: 20,
      paymentDsoLowDays: 15,
      paymentDsoLowPenalty: 10,
      paymentOverduePerInvoice: 10,
      paymentOverdueCap: 40,
      paymentRatingExcellent: 80,
      paymentRatingGood: 60,
      paymentRatingFair: 40,
      // Profit tiers (margin points) and the relative profit-leak definition:
      // revenue share of the period total at or above the share, with margin
      // below the leak target.
      profitHighMargin: 40,
      profitMediumMargin: 25,
      profitLowMargin: 10,
      profitLeakMarginTarget: 15,
      profitLeakRevenueSharePct: 10,
      // Nurture: health floor plus a percentile of the CLV distribution.
      nurtureMinHealth: 85,
      nurtureClvPercentile: 90,
      // Growth: maturity floor, MoM caps, trend band and window, YoY window,
      // insight count. Cohorts count a customer active within the active months.
      growthMaturityFloorPct: 10,
      growthMomCapUp: 200,
      growthMomCapDown: 80,
      growthTrendPct: 10,
      growthTrendWindowMonths: 6,
      yoyRecentMonths: 3,
      cohortActiveMonths: 6,
      overdueInsightCount: 5,
    },
    fields: [
      num("churnCriticalScore", "analytics.customer.config.fields.churnCritical", 1, 100),
      num("churnHighScore", "analytics.customer.config.fields.churnHigh", 1, 100),
      num("churnMediumScore", "analytics.customer.config.fields.churnMedium", 1, 100),
      num("hhiWarning", "analytics.customer.config.fields.hhiWarning", 0, 10_000, 100),
      num("hhiCritical", "analytics.customer.config.fields.hhiCritical", 0, 10_000, 100),
      num("clvYears", "analytics.customer.config.fields.clvYears", 1, 10),
      pct("healthWeightRecency", "analytics.customer.config.fields.healthWeightRecency"),
      pct("healthWeightFrequency", "analytics.customer.config.fields.healthWeightFrequency"),
      pct("healthWeightMonetary", "analytics.customer.config.fields.healthWeightMonetary"),
      pct("healthWeightPayment", "analytics.customer.config.fields.healthWeightPayment"),
      pct("intelWeightChampions", "analytics.customer.config.fields.intelWeightChampions"),
      pct("intelWeightRetention", "analytics.customer.config.fields.intelWeightRetention"),
      pct("intelWeightConcentration", "analytics.customer.config.fields.intelWeightConcentration"),
      pct("intelWeightPayment", "analytics.customer.config.fields.intelWeightPayment"),
      num("gradeAPlus", "analytics.customer.config.fields.gradeAPlus", 1, 100),
      num("gradeA", "analytics.customer.config.fields.gradeA", 1, 100),
      num("gradeB", "analytics.customer.config.fields.gradeB", 1, 100),
      num("gradeC", "analytics.customer.config.fields.gradeC", 1, 100),
      num("gradeD", "analytics.customer.config.fields.gradeD", 1, 100),
      num("recencyGoodDays", "analytics.customer.config.fields.recencyGoodDays", 1, 730),
      num("recencyWarningDays", "analytics.customer.config.fields.recencyWarningDays", 1, 730),
      num("recencyCriticalDays", "analytics.customer.config.fields.recencyCriticalDays", 1, 730),
      num("churnHighDays", "analytics.customer.config.fields.churnHighDays", 1, 730),
      num("churnMediumDays", "analytics.customer.config.fields.churnMediumDays", 1, 365),
      num("churnInactiveLowDays", "analytics.customer.config.fields.churnInactiveLowDays", 1, 365),
      num("churnInactiveCriticalPoints", "analytics.customer.config.fields.churnInactiveCriticalPoints", 0, 100),
      num("churnInactiveHighPoints", "analytics.customer.config.fields.churnInactiveHighPoints", 0, 100),
      num("churnInactiveLowPoints", "analytics.customer.config.fields.churnInactiveLowPoints", 0, 100),
      num("churnCadenceHighMultiple", "analytics.customer.config.fields.churnCadenceHighMultiple", 1, 10, 0.1),
      num("churnCadenceLowMultiple", "analytics.customer.config.fields.churnCadenceLowMultiple", 1, 10, 0.1),
      num("churnCadenceHighPoints", "analytics.customer.config.fields.churnCadenceHighPoints", 0, 100),
      num("churnCadenceLowPoints", "analytics.customer.config.fields.churnCadenceLowPoints", 0, 100),
      num("churnSingleMaxTxns", "analytics.customer.config.fields.churnSingleMaxTxns", 1, 10),
      num("churnFewMaxTxns", "analytics.customer.config.fields.churnFewMaxTxns", 2, 20),
      num("churnSinglePoints", "analytics.customer.config.fields.churnSinglePoints", 0, 100),
      num("churnFewPoints", "analytics.customer.config.fields.churnFewPoints", 0, 100),
      num("clvMinYears", "analytics.customer.config.fields.clvMinYears", 0.05, 5, 0.05),
      pct("clvRetentionBase", "analytics.customer.config.fields.clvRetentionBase", 1, 100),
      num("clvRetentionDecayDays", "analytics.customer.config.fields.clvRetentionDecayDays", 1, 730),
      pct("clvRetentionMinPct", "analytics.customer.config.fields.clvRetentionMinPct"),
      pct("clvRetentionMaxPct", "analytics.customer.config.fields.clvRetentionMaxPct"),
      pct("tierPlatinumPct", "analytics.customer.config.fields.tierPlatinumPct", 1, 100),
      pct("tierGoldPct", "analytics.customer.config.fields.tierGoldPct", 1, 100),
      pct("tierSilverPct", "analytics.customer.config.fields.tierSilverPct", 1, 100),
      pct("concentrationCriticalShare", "analytics.customer.config.fields.concentrationCriticalShare"),
      pct("concentrationHighShare", "analytics.customer.config.fields.concentrationHighShare"),
      pct("concentrationMediumShare", "analytics.customer.config.fields.concentrationMediumShare"),
      pct("concentrationCoverageShare", "analytics.customer.config.fields.concentrationCoverageShare", 1, 100),
      num("topSharePct", "analytics.customer.config.fields.topSharePct", 1, 100),
      pct("concentrationHealthHigh", "analytics.customer.config.fields.concentrationHealthHigh"),
      pct("concentrationHealthModerate", "analytics.customer.config.fields.concentrationHealthModerate"),
      pct("concentrationHealthLow", "analytics.customer.config.fields.concentrationHealthLow"),
      num("velocityUrgencyHighMultiple", "analytics.customer.config.fields.velocityUrgencyHighMultiple", 0.1, 0.9, 0.05),
      num("velocityDueSoonDays", "analytics.customer.config.fields.velocityDueSoonDays", 0, 30),
      num("frictionPointsPerCredit", "analytics.customer.config.fields.frictionPointsPerCredit", 1, 10),
      num("frictionCriticalPoints", "analytics.customer.config.fields.frictionCriticalPoints", 0, 100),
      num("frictionHighPoints", "analytics.customer.config.fields.frictionHighPoints", 0, 100),
      num("frictionMediumPoints", "analytics.customer.config.fields.frictionMediumPoints", 0, 100),
      num("frictionPenaltyCritical", "analytics.customer.config.fields.frictionPenaltyCritical", 0, 100),
      num("frictionPenaltyHigh", "analytics.customer.config.fields.frictionPenaltyHigh", 0, 100),
      num("frictionPenaltyMedium", "analytics.customer.config.fields.frictionPenaltyMedium", 0, 100),
      pct("frictionCriticalRate", "analytics.customer.config.fields.frictionCriticalRate"),
      pct("frictionHighRate", "analytics.customer.config.fields.frictionHighRate"),
      pct("frictionMediumRate", "analytics.customer.config.fields.frictionMediumRate"),
      num("paymentDsoHighDays", "analytics.customer.config.fields.paymentDsoHighDays", 1, 180),
      num("paymentDsoHighPenalty", "analytics.customer.config.fields.paymentDsoHighPenalty", 0, 100),
      num("paymentDsoMediumDays", "analytics.customer.config.fields.paymentDsoMediumDays", 1, 180),
      num("paymentDsoMediumPenalty", "analytics.customer.config.fields.paymentDsoMediumPenalty", 0, 100),
      num("paymentDsoLowDays", "analytics.customer.config.fields.paymentDsoLowDays", 1, 180),
      num("paymentDsoLowPenalty", "analytics.customer.config.fields.paymentDsoLowPenalty", 0, 100),
      num("paymentOverduePerInvoice", "analytics.customer.config.fields.paymentOverduePerInvoice", 0, 100),
      num("paymentOverdueCap", "analytics.customer.config.fields.paymentOverdueCap", 0, 100),
      num("paymentRatingExcellent", "analytics.customer.config.fields.paymentRatingExcellent", 1, 100),
      num("paymentRatingGood", "analytics.customer.config.fields.paymentRatingGood", 1, 100),
      num("paymentRatingFair", "analytics.customer.config.fields.paymentRatingFair", 1, 100),
      pct("profitHighMargin", "analytics.customer.config.fields.profitHighMargin", -100, 100),
      pct("profitMediumMargin", "analytics.customer.config.fields.profitMediumMargin", -100, 100),
      pct("profitLowMargin", "analytics.customer.config.fields.profitLowMargin", -100, 100),
      pct("profitLeakMarginTarget", "analytics.customer.config.fields.profitLeakMarginTarget", -100, 100),
      pct("profitLeakRevenueSharePct", "analytics.customer.config.fields.profitLeakRevenueSharePct"),
      num("nurtureMinHealth", "analytics.customer.config.fields.nurtureMinHealth", 1, 100),
      pct("nurtureClvPercentile", "analytics.customer.config.fields.nurtureClvPercentile", 1, 100),
      pct("growthMaturityFloorPct", "analytics.customer.config.fields.growthMaturityFloorPct"),
      num("growthMomCapUp", "analytics.customer.config.fields.growthMomCapUp", 0, 1000),
      num("growthMomCapDown", "analytics.customer.config.fields.growthMomCapDown", 0, 1000),
      pct("growthTrendPct", "analytics.customer.config.fields.growthTrendPct"),
      num("growthTrendWindowMonths", "analytics.customer.config.fields.growthTrendWindowMonths", 2, 12),
      num("yoyRecentMonths", "analytics.customer.config.fields.yoyRecentMonths", 1, 12),
      num("cohortActiveMonths", "analytics.customer.config.fields.cohortActiveMonths", 1, 24),
      num("overdueInsightCount", "analytics.customer.config.fields.overdueInsightCount", 1, 1000),
    ],
    ordered: [
      ["churnMediumScore", "churnHighScore", "churnCriticalScore"],
      ["hhiWarning", "hhiCritical"],
      ["gradeD", "gradeC", "gradeB", "gradeA", "gradeAPlus"],
      ["recencyGoodDays", "recencyWarningDays", "recencyCriticalDays"],
      ["frictionMediumPoints", "frictionHighPoints", "frictionCriticalPoints"],
      ["frictionPenaltyMedium", "frictionPenaltyHigh", "frictionPenaltyCritical"],
      ["frictionMediumRate", "frictionHighRate", "frictionCriticalRate"],
      ["churnInactiveLowDays", "churnMediumDays", "churnHighDays"],
      ["churnCadenceLowMultiple", "churnCadenceHighMultiple"],
      ["churnInactiveLowPoints", "churnInactiveHighPoints", "churnInactiveCriticalPoints"],
      ["churnCadenceLowPoints", "churnCadenceHighPoints"],
      ["churnSingleMaxTxns", "churnFewMaxTxns"],
      ["churnFewPoints", "churnSinglePoints"],
      ["clvRetentionMinPct", "clvRetentionMaxPct"],
      ["tierPlatinumPct", "tierGoldPct", "tierSilverPct"],
      ["concentrationMediumShare", "concentrationHighShare", "concentrationCriticalShare"],
      ["concentrationHealthHigh", "concentrationHealthModerate", "concentrationHealthLow"],
      ["paymentDsoLowDays", "paymentDsoMediumDays", "paymentDsoHighDays"],
      ["paymentDsoLowPenalty", "paymentDsoMediumPenalty", "paymentDsoHighPenalty"],
      ["paymentRatingFair", "paymentRatingGood", "paymentRatingExcellent"],
      ["profitLowMargin", "profitMediumMargin", "profitHighMargin"],
    ],
    sumsTo: [
      {
        keys: ["healthWeightRecency", "healthWeightFrequency", "healthWeightMonetary", "healthWeightPayment"],
        total: 100,
      },
      {
        keys: ["intelWeightChampions", "intelWeightRetention", "intelWeightConcentration", "intelWeightPayment"],
        total: 100,
      },
    ],
    groups: [
      { labelKey: "analytics.customer.config.groups.scores", fields: ["healthWeightRecency", "healthWeightFrequency", "healthWeightMonetary", "healthWeightPayment", "intelWeightChampions", "intelWeightRetention", "intelWeightConcentration", "intelWeightPayment"] },
      { labelKey: "analytics.customer.config.groups.grades", fields: ["gradeAPlus", "gradeA", "gradeB", "gradeC", "gradeD"] },
      { labelKey: "analytics.customer.config.groups.recency", fields: ["recencyGoodDays", "recencyWarningDays", "recencyCriticalDays"] },
      { labelKey: "analytics.customer.config.groups.churn", fields: ["churnCriticalScore", "churnHighScore", "churnMediumScore", "churnHighDays", "churnMediumDays", "churnInactiveLowDays", "churnInactiveHighPoints", "churnInactiveCriticalPoints", "churnInactiveLowPoints", "churnCadenceHighMultiple", "churnCadenceLowMultiple", "churnCadenceHighPoints", "churnCadenceLowPoints", "churnSingleMaxTxns", "churnFewMaxTxns", "churnSinglePoints", "churnFewPoints", "velocityUrgencyHighMultiple", "velocityDueSoonDays"] },
      { labelKey: "analytics.customer.config.groups.payment", fields: ["paymentDsoHighDays", "paymentDsoHighPenalty", "paymentDsoMediumDays", "paymentDsoMediumPenalty", "paymentDsoLowDays", "paymentDsoLowPenalty", "paymentOverduePerInvoice", "paymentOverdueCap", "paymentRatingExcellent", "paymentRatingGood", "paymentRatingFair"] },
      { labelKey: "analytics.customer.config.groups.clv", fields: ["clvMinYears", "clvYears", "clvRetentionBase", "clvRetentionDecayDays", "clvRetentionMinPct", "clvRetentionMaxPct", "tierPlatinumPct", "tierGoldPct", "tierSilverPct", "nurtureMinHealth", "nurtureClvPercentile"] },
      { labelKey: "analytics.customer.config.groups.concentration", fields: ["hhiWarning", "hhiCritical", "concentrationCriticalShare", "concentrationHighShare", "concentrationMediumShare", "concentrationCoverageShare", "topSharePct", "concentrationHealthHigh", "concentrationHealthModerate", "concentrationHealthLow"] },
      { labelKey: "analytics.customer.config.groups.friction", fields: ["frictionPointsPerCredit", "frictionCriticalPoints", "frictionHighPoints", "frictionMediumPoints", "frictionPenaltyCritical", "frictionPenaltyHigh", "frictionPenaltyMedium", "frictionCriticalRate", "frictionHighRate", "frictionMediumRate"] },
      { labelKey: "analytics.customer.config.groups.profit", fields: ["profitHighMargin", "profitMediumMargin", "profitLowMargin", "profitLeakMarginTarget", "profitLeakRevenueSharePct"] },
      { labelKey: "analytics.customer.config.groups.growth", fields: ["growthMaturityFloorPct", "growthMomCapUp", "growthMomCapDown", "growthTrendPct", "growthTrendWindowMonths", "yoyRecentMonths", "cohortActiveMonths", "overdueInsightCount"] },
    ],
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
      engagementMaxPoints: 30,
      stabilityMaxPoints: 30,
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
      num("engagementMaxPoints", "analytics.vendor.config.fields.engagementMaxPoints", 0, 100),
      num("stabilityMaxPoints", "analytics.vendor.config.fields.stabilityMaxPoints", 0, 100),
      num("neutralStabilityScore", "analytics.vendor.config.fields.neutralStabilityScore", 0, 100),
      num("highSpendPercentile", "analytics.vendor.config.fields.highSpendPercentile", 0, 100),
      num("highPerformanceScore", "analytics.vendor.config.fields.highPerformanceScore", 0, 100),
      num("hhiWarning", "analytics.vendor.config.fields.hhiWarning", 0, 10_000, 100),
      num("hhiCritical", "analytics.vendor.config.fields.hhiCritical", 0, 10_000, 100),
      pct("onTimeGoodRate", "analytics.vendor.config.fields.onTimeGoodRate", 0, 100),
      num("slowPayDays", "analytics.vendor.config.fields.slowPayDays", 0, 365),
    ],
    ordered: [["gradeD", "gradeC", "gradeB", "gradeA"], ["tierStrategicPct", "tierCorePct", "tierTacticalPct"], ["hhiWarning", "hhiCritical"]],
    groups: [
      { labelKey: "analytics.vendor.config.groups.grading", fields: ["gradeA", "gradeB", "gradeC", "gradeD"] },
      { labelKey: "analytics.vendor.config.groups.tiers", fields: ["tierStrategicPct", "tierCorePct", "tierTacticalPct"] },
      { labelKey: "analytics.vendor.config.groups.scorecard", fields: ["significanceStrategic", "significanceCore", "significanceTactical", "significanceTail", "engagementCapBills", "engagementMaxPoints", "stabilityMaxPoints", "neutralStabilityScore"] },
      { labelKey: "analytics.vendor.config.groups.concentration", fields: ["highSpendPercentile", "highPerformanceScore", "hhiWarning", "hhiCritical"] },
      { labelKey: "analytics.vendor.config.groups.paymentMarks", fields: ["onTimeGoodRate", "slowPayDays"] },
    ],
  },
  sentinel: {
    slug: "sentinel",
    // Money thresholds are exact decimal strings in the organization's
    // presentation currency (the cashflow.weeklyApCap pattern): detectors
    // compare ledger amounts only after translating them into that
    // currency, so a threshold means the same in every subsidiary.
    defaults: {
      duplicateDays: 14,
      // Unset until the organization names its own duplicate floor: a
      // comparison without a threshold is refused by name instead of
      // silently applying a figure that means different money per currency.
      duplicateMinAmount: "",
      sequentialMinCount: 3,
      sequentialMinDays: 7,
      summaryFlaggedMedium: 20,
      summaryFlaggedHigh: 50,
      moderateRiskAmount: "1000.0000",
      highRiskAmount: "10000.0000",
      criticalRiskAmount: "25000.0000",
      aggregateHighAmount: "50000.0000",
      aggregateCriticalAmount: "100000.0000",
      rsfBaselineFloor: "100.0000",
      zscoreSigmaFloor: "10.0000",
      zscoreThreshold: 3,
      zscoreMinBaseline: 5,
      rsfThreshold: 10,
      baselineMonths: 36,
      sequentialHighRiskDays: 30,
      benfordMinSample: 50,
      trapBandPercent: 5,
      duplicateAreaMin: 10,
      ghostNameMinLength: 7,
    },
    fields: [
      num("duplicateDays", "analytics.sentinel.config.fields.duplicateDays", 1, 90),
      { key: "duplicateMinAmount", kind: "money", optional: true, labelKey: "analytics.sentinel.config.fields.duplicateMinAmount.label", helpKey: "analytics.sentinel.config.fields.duplicateMinAmount.help", maxAmount: "100000000" },
      num("sequentialMinCount", "analytics.sentinel.config.fields.sequentialMinCount", 2, 50),
      num("sequentialMinDays", "analytics.sentinel.config.fields.sequentialMinDays", 1, 365),
      num("summaryFlaggedMedium", "analytics.sentinel.config.fields.summaryFlaggedMedium", 1, 10000),
      num("summaryFlaggedHigh", "analytics.sentinel.config.fields.summaryFlaggedHigh", 2, 100000),
      { key: "moderateRiskAmount", kind: "money", labelKey: "analytics.sentinel.config.fields.moderateRiskAmount.label", helpKey: "analytics.sentinel.config.fields.moderateRiskAmount.help", maxAmount: "100000000" },
      { key: "highRiskAmount", kind: "money", labelKey: "analytics.sentinel.config.fields.highRiskAmount.label", helpKey: "analytics.sentinel.config.fields.highRiskAmount.help", maxAmount: "100000000" },
      { key: "criticalRiskAmount", kind: "money", labelKey: "analytics.sentinel.config.fields.criticalRiskAmount.label", helpKey: "analytics.sentinel.config.fields.criticalRiskAmount.help", maxAmount: "100000000" },
      { key: "aggregateHighAmount", kind: "money", labelKey: "analytics.sentinel.config.fields.aggregateHighAmount.label", helpKey: "analytics.sentinel.config.fields.aggregateHighAmount.help", maxAmount: "1000000000" },
      { key: "aggregateCriticalAmount", kind: "money", labelKey: "analytics.sentinel.config.fields.aggregateCriticalAmount.label", helpKey: "analytics.sentinel.config.fields.aggregateCriticalAmount.help", maxAmount: "1000000000" },
      { key: "rsfBaselineFloor", kind: "money", labelKey: "analytics.sentinel.config.fields.rsfBaselineFloor.label", helpKey: "analytics.sentinel.config.fields.rsfBaselineFloor.help", maxAmount: "100000000" },
      { key: "zscoreSigmaFloor", kind: "money", labelKey: "analytics.sentinel.config.fields.zscoreSigmaFloor.label", helpKey: "analytics.sentinel.config.fields.zscoreSigmaFloor.help", maxAmount: "100000000" },
      num("zscoreThreshold", "analytics.sentinel.config.fields.zscoreThreshold", 1, 10, 0.1),
      num("zscoreMinBaseline", "analytics.sentinel.config.fields.zscoreMinBaseline", 3, 36),
      num("rsfThreshold", "analytics.sentinel.config.fields.rsfThreshold", 2, 100, 0.5),
      num("baselineMonths", "analytics.sentinel.config.fields.baselineMonths", 3, 120),
      num("sequentialHighRiskDays", "analytics.sentinel.config.fields.sequentialHighRiskDays", 7, 365),
      num("benfordMinSample", "analytics.sentinel.config.fields.benfordMinSample", 10, 1000),
      pct("trapBandPercent", "analytics.sentinel.config.fields.trapBandPercent", 0, 50),
      num("duplicateAreaMin", "analytics.sentinel.config.fields.duplicateAreaMin", 1, 100),
      num("ghostNameMinLength", "analytics.sentinel.config.fields.ghostNameMinLength", 2, 20),
    ],
    ordered: [
      ["moderateRiskAmount", "highRiskAmount", "criticalRiskAmount"],
      ["aggregateHighAmount", "aggregateCriticalAmount"],
      ["summaryFlaggedMedium", "summaryFlaggedHigh"],
    ],
    // Sections the editor renders with headings: per-detector cut-offs,
    // presentation-currency floors, summary scoring bands, then the
    // statistical windows the detectors run on.
    groups: [
      { labelKey: "analytics.sentinel.config.groups.detection", fields: ["duplicateDays", "duplicateMinAmount", "duplicateAreaMin", "sequentialMinCount", "sequentialMinDays", "sequentialHighRiskDays", "trapBandPercent", "ghostNameMinLength"] },
      { labelKey: "analytics.sentinel.config.groups.moneyFloors", fields: ["moderateRiskAmount", "highRiskAmount", "criticalRiskAmount", "aggregateHighAmount", "aggregateCriticalAmount", "rsfBaselineFloor", "zscoreSigmaFloor"] },
      { labelKey: "analytics.sentinel.config.groups.scoringBands", fields: ["summaryFlaggedMedium", "summaryFlaggedHigh"] },
      { labelKey: "analytics.sentinel.config.groups.modelParameters", fields: ["zscoreThreshold", "zscoreMinBaseline", "rsfThreshold", "baselineMonths", "benfordMinSample"] },
    ],
  },
  cashflow: {
    slug: "cashflow",
    // A zero cap means payables are not capacity-scheduled. Zero carries no
    // currency, so the default is meaningful in every presentation currency.
    // The forecast-model knobs below are plain numbers (weeks, days, month
    // counts, sigma multiples, day-of-month): they carry no currency either,
    // so one default serves every organization until it tunes them.
    defaults: {
      weeklyApCap: "0.0000",
      restrictToSafe: 0,
      defaultHorizonWeeks: 13,
      runwayCautionWeeks: 8,
      paymentHistoryMonths: 12,
      settleBufferSigma: 0.5,
      overduePushShortDays: 7,
      overduePushMidDays: 14,
      overduePushLongDays: 28,
      overdueMidThresholdDays: 30,
      overdueLongThresholdDays: 60,
      cardTrajectoryTolerance: 0.2,
      cardMedianBlendWeight: 0.7,
      vendorOutlierSigma: 2,
      cardStatementCloseDays: 27,
      cardDefaultPayDay: 24,
      cardStalePaymentDays: 30,
    },
    fields: [
      { key: "weeklyApCap", kind: "money", labelKey: "ap.cockpit.config.weeklyCapLabel", helpKey: "ap.cockpit.config.weeklyCapHelp", maxAmount: "100000000" },
      { key: "restrictToSafe", kind: "toggle", labelKey: "ap.cockpit.config.restrictLabel", helpKey: "ap.cockpit.config.restrictHelp" },
      num("defaultHorizonWeeks", "analytics.cashflow.config.fields.defaultHorizonWeeks", 1, 52, 1, true),
      num("runwayCautionWeeks", "analytics.cashflow.config.fields.runwayCautionWeeks", 1, 52, 1, true),
      num("paymentHistoryMonths", "analytics.cashflow.config.fields.paymentHistoryMonths", 3, 36, 1, true),
      num("settleBufferSigma", "analytics.cashflow.config.fields.settleBufferSigma", 0, 2, 0.1),
      num("overduePushShortDays", "analytics.cashflow.config.fields.overduePushShortDays", 0, 90, 1, true),
      num("overduePushMidDays", "analytics.cashflow.config.fields.overduePushMidDays", 0, 90, 1, true),
      num("overduePushLongDays", "analytics.cashflow.config.fields.overduePushLongDays", 0, 90, 1, true),
      num("overdueMidThresholdDays", "analytics.cashflow.config.fields.overdueMidThresholdDays", 1, 180, 1, true),
      num("overdueLongThresholdDays", "analytics.cashflow.config.fields.overdueLongThresholdDays", 1, 180, 1, true),
      num("cardTrajectoryTolerance", "analytics.cashflow.config.fields.cardTrajectoryTolerance", 0, 1, 0.05),
      num("cardMedianBlendWeight", "analytics.cashflow.config.fields.cardMedianBlendWeight", 0, 1, 0.05),
      num("vendorOutlierSigma", "analytics.cashflow.config.fields.vendorOutlierSigma", 0.5, 6, 0.1),
      num("cardStatementCloseDays", "analytics.cashflow.config.fields.cardStatementCloseDays", 1, 60, 1, true),
      num("cardDefaultPayDay", "analytics.cashflow.config.fields.cardDefaultPayDay", 1, 31, 1, true),
      num("cardStalePaymentDays", "analytics.cashflow.config.fields.cardStalePaymentDays", 0, 365, 1, true),
    ],
    ordered: [
      ["overduePushShortDays", "overduePushMidDays", "overduePushLongDays"],
      ["overdueMidThresholdDays", "overdueLongThresholdDays"],
    ],
    groups: [
      { labelKey: "analytics.cashflow.config.groups.forecast", fields: ["defaultHorizonWeeks", "runwayCautionWeeks", "paymentHistoryMonths"] },
      { labelKey: "analytics.cashflow.config.groups.scheduling", fields: ["weeklyApCap", "restrictToSafe"] },
      { labelKey: "analytics.cashflow.config.groups.prediction", fields: ["settleBufferSigma", "overduePushShortDays", "overduePushMidDays", "overduePushLongDays", "overdueMidThresholdDays", "overdueLongThresholdDays", "vendorOutlierSigma"] },
      { labelKey: "analytics.cashflow.config.groups.cards", fields: ["cardTrajectoryTolerance", "cardMedianBlendWeight", "cardStatementCloseDays", "cardDefaultPayDay", "cardStalePaymentDays"] },
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
      structuralTop1High: 30,
      structuralTop1Medium: 25,
      structuralTop1Low: 20,
      savingsRatioWatch: 0.5,
      savingsRatioLow: 1,
      savingsRatioMedium: 2,
      savingsRatioHigh: 3,
      savingsRatioCritical: 5,
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
      num("structuralTop1High", "analytics.spendVelocity.config.fields.structuralTop1High", 0, 100),
      num("structuralTop1Medium", "analytics.spendVelocity.config.fields.structuralTop1Medium", 0, 100),
      num("structuralTop1Low", "analytics.spendVelocity.config.fields.structuralTop1Low", 0, 100),
      num("savingsRatioWatch", "analytics.spendVelocity.config.fields.savingsRatioWatch", 0, 100, 0.1),
      num("savingsRatioLow", "analytics.spendVelocity.config.fields.savingsRatioLow", 0, 100, 0.1),
      num("savingsRatioMedium", "analytics.spendVelocity.config.fields.savingsRatioMedium", 0, 100, 0.1),
      num("savingsRatioHigh", "analytics.spendVelocity.config.fields.savingsRatioHigh", 0, 100, 0.1),
      num("savingsRatioCritical", "analytics.spendVelocity.config.fields.savingsRatioCritical", 0, 100, 0.1),
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
    groups: [
      { labelKey: "analytics.spendVelocity.config.groups.growth", fields: ["velocityHighThreshold", "velocityMediumThreshold", "accelStrong", "accelMild", "minBaseAmount", "topVendorsCount"] },
      { labelKey: "analytics.spendVelocity.config.groups.anomalyDetection", fields: ["anomalyStdDevThreshold", "anomalyCriticalOffset"] },
      { labelKey: "analytics.spendVelocity.config.groups.creepAndZombies", fields: ["boilingFrogMonths", "boilingFrogMinIncrease", "boilingFrogStepCap", "boilingFrogMonotonicRatio", "boilingFrogWarningCreep", "boilingFrogCriticalCreep", "zombieMinMonths", "zombieMaxDeviation", "zombieCriticalMonths"] },
      { labelKey: "analytics.spendVelocity.config.groups.fragmentation", fields: ["fragmentationMinTxns", "fragmentationMaxAvgSize", "fragmentationHighTxns"] },
      { labelKey: "analytics.spendVelocity.config.groups.seasonal", fields: ["seasonalBand", "seasonalCriticalDeviation"] },
      { labelKey: "analytics.spendVelocity.config.groups.concentration", fields: ["hhiWarning", "hhiCritical", "concentrationShareThreshold", "concentrationHighShare", "concentrationTop1Warning"] },
      { labelKey: "analytics.spendVelocity.config.groups.cliff", fields: ["cliffWarningGap", "cliffCriticalGap", "cliffWarningRatio", "cliffCriticalRatio"] },
      { labelKey: "analytics.spendVelocity.config.groups.projections", fields: ["projectionCapAccount", "projectionCapTotal"] },
      { labelKey: "analytics.spendVelocity.config.groups.insightTriggers", fields: ["categoryIncreaseThreshold", "spenderIncreaseThreshold", "highVelocityAlert", "typeImbalanceGap", "opexRatioAlert", "alertBannerThreshold", "accountFilterChange", "accountFilterHighVel"] },
      { labelKey: "analytics.spendVelocity.config.groups.grading", fields: ["healthGradeA", "healthGradeB", "healthGradeC", "healthGradeD"] },
      { labelKey: "analytics.spendVelocity.config.groups.structuralBands", fields: ["structuralTop1High", "structuralTop1Medium", "structuralTop1Low"] },
      { labelKey: "analytics.spendVelocity.config.groups.savingsBands", fields: ["savingsRatioWatch", "savingsRatioLow", "savingsRatioMedium", "savingsRatioHigh", "savingsRatioCritical"] },
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
      if (field.int === true && !Number.isInteger(parsed)) {
        throw new InvalidConfigValue(
          field.key,
          `threshold ${fieldName(field)} must be a whole number (received ${String(value).slice(0, 60)})`,
        );
      }
      return parsed;
    }
  }
}

function comparable(value: AnalyticsConfigValue): string | null {
  return value === "" ? null : String(value);
}

export interface SumsToViolation {
  keys: readonly string[];
  total: number;
  actual: number;
  /** A listed key is missing or not a finite number: no sum exists to state. */
  unreadable?: boolean;
}

/**
 * Weight-group check shared by the write path and dashboard loaders: every
 * listed key must be a finite number and the group must sum to `total`.
 * Weights are percentage points, not money, so the comparison allows binary
 * floating-point dust far below any displayed precision.
 */
export function checkSumsTo(
  spec: AnalyticsConfigSpec,
  values: AnalyticsConfigValues,
): SumsToViolation | null {
  for (const rule of spec.sumsTo ?? []) {
    let actual = 0;
    let readable = true;
    for (const key of rule.keys) {
      const value = values[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        readable = false;
        break;
      }
      actual += value;
    }
    // An unreadable key refuses like a broken sum: a hand-edited blob
    // bypasses the write validation that would have caught the wrong type,
    // so passing it here would silently rescale every figure below.
    if (!readable) {
      return { keys: rule.keys, total: rule.total, actual: Number.NaN, unreadable: true };
    }
    if (Math.abs(actual - rule.total) > 1e-9) {
      return { keys: rule.keys, total: rule.total, actual };
    }
  }
  return null;
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
  const weights = checkSumsTo(spec, out);
  if (weights) {
    const names = weights.keys.map((key) => `'${key}'`).join(", ");
    throw new InvalidConfigValue(
      weights.keys[weights.keys.length - 1]!,
      `thresholds ${names} must sum to ${weights.total} (currently ${weights.actual}) — weights are percentage points of one composite score, so a partial total would silently rescale every grade`,
    );
  }
  return out;
}
