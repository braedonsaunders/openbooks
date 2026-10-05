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
    defaults: {
      grossMarginTarget: 40,
      operatingMarginTarget: 15,
      ebitdaMarginTarget: 20,
      netMarginTarget: 10,
      roaTarget: 8,
      roeTarget: 15,
      roicTarget: 12,
      revenuePerEmployee: 200_000,
      gpPerEmployee: 80_000,
    },
    fields: [
      pct("grossMarginTarget", "analytics.financialHealth.config.fields.grossMarginTarget"),
      pct("operatingMarginTarget", "analytics.financialHealth.config.fields.operatingMarginTarget"),
      pct("ebitdaMarginTarget", "analytics.financialHealth.config.fields.ebitdaMarginTarget"),
      pct("netMarginTarget", "analytics.financialHealth.config.fields.netMarginTarget"),
      pct("roaTarget", "analytics.financialHealth.config.fields.roaTarget"),
      pct("roeTarget", "analytics.financialHealth.config.fields.roeTarget"),
      pct("roicTarget", "analytics.financialHealth.config.fields.roicTarget"),
      num("revenuePerEmployee", "analytics.financialHealth.config.fields.revenuePerEmployee", 0, 10_000_000, 5_000),
      num("gpPerEmployee", "analytics.financialHealth.config.fields.gpPerEmployee", 0, 10_000_000, 5_000),
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
