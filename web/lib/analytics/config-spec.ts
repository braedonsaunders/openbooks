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
      boilingFrogMonths: 6,
      zombieMinMonths: 6,
      fragmentationMinTxns: 20,
      fragmentationMaxAvgSize: 500,
    },
    fields: [
      pct("velocityHighThreshold", "analytics.spendVelocity.config.fields.highVelocity", 1, 100),
      pct("velocityMediumThreshold", "analytics.spendVelocity.config.fields.mediumVelocity", 0, 50),
      num("anomalyStdDevThreshold", "analytics.spendVelocity.config.fields.anomalySigma", 1, 6, 0.1),
      num("boilingFrogMonths", "analytics.spendVelocity.config.fields.boilingFrogMonths", 3, 24),
      num("zombieMinMonths", "analytics.spendVelocity.config.fields.zombieMonths", 3, 24),
      num("fragmentationMinTxns", "analytics.spendVelocity.config.fields.fragmentationTxns", 5, 500, 5),
      num("fragmentationMaxAvgSize", "analytics.spendVelocity.config.fields.fragmentationAvgSize", 50, 10_000, 50),
    ],
    ordered: [["velocityMediumThreshold", "velocityHighThreshold"]],
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
