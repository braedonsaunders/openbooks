import "server-only";
import { analyticsQuery } from "../analytics/query";
import { sql } from "drizzle-orm";
import { ACCOUNT_CLASS_TYPES } from "../../../engine/src/records/account-types.ts";
import { advanceAnchoredMonth } from "@openbooks/engine/src/billing/cadence.ts";
import { addCalendarDays, addMonthsClamped, businessToday, calendarDaysBetween, daysInCivilMonth, parseIsoDate, utcDateFromParts } from "@openbooks/engine/src/platform/business-date.ts";
import { fiscalMonthOffset } from "@openbooks/reports";
import { enactedIncomeTaxRate } from "@openbooks/engine/tax-returns";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { abs as moneyAbs, add as moneyAdd, cmp as moneyCmp, div as moneyDiv, mulDecimal, neg as moneyNeg, normalizeMoney, sum as moneySum } from "@openbooks/engine/src/money/money.ts";
import { ANALYTICS_CONFIG } from "../analytics/config-spec";
import { analyticsConfig } from "../analytics/config";
import { evaluateFormula } from "./formula";
import { agingBasisDate, agingBucketIndex } from "../aging-basis";
import { monthYearLabel } from "../format";
import { getMoneyFormatter } from '../money-server'
import { resolveOrgId } from '../org-scope'
import { statementBookExpr } from '../gl-summary'
import { flowRates, lineFunctional, MissingExchangeRateError, presentationCurrency, presentationRates } from '../fx-presentation'

interface CashWeeklyHistoryRow extends Record<string, unknown> {
  wk: string
  number: string | null
  name: string
  net: string
  gross: string
  /** Line entity's functional currency (translated before adding). */
  func: string | null
  /** Bucket's latest posting date (the translation date). */
  late: string
}

interface CashDailyRow extends Record<string, unknown> {
  day: string
  spend: string
  paid: string
  /** Line entity's functional currency (translated before adding). */
  func: string | null
}

interface CashPaymentEventRow extends Record<string, unknown> {
  day: string
  paid: string
  /** Line entity's functional currency (translated before adding). */
  func: string | null
  /** Bucket's latest document date (the translation date). */
  late: string
}

interface CashRegisterLineRow extends Record<string, unknown> {
  day: string
  kind: string
  doc_number: string | null
  party: string
  memo: string
  entry_id: string
  raw_amount: string
  /** Line entity's functional currency (translated before netting/adding). */
  func: string | null
}

export { openItems } from './open-items'
export { CASH_HORIZON_PRESETS, MAX_CASH_HORIZON_WEEKS, normalizeCashHorizonWeeks } from './horizon'

/**
 * Shared cash-engine core — the primitives behind BOTH the read-only analytics
 * cashflow forecast (analytics/cashflow) and the operational domain cockpits
 * (AP / AR / Banking-Cash). It was extracted from the original
 * analytics `cashflow-data.ts` so the numbers stay byte-identical.
 *
 * Rule of the house: one source of truth. Analytics *explains* the forecast,
 * cockpits *act* on it — but both read the same predicted dates, aging buckets
 * and payment statistics computed here.
 *
 * All dates are handled as UTC-midnight to match the ledger's date columns.
 */

export const MS_DAY = 86_400_000;
/** Canonical numeric(19,4) zero used by every cash forecast money field. */
export const ZERO_MONEY = "0.0000";
export type Money = string;
export const addMoney = moneyAdd;
export const subtractMoney = (a: Money, b: Money): Money => moneyAdd(a, moneyNeg(b));
export const compareMoney = moneyCmp;
export const absMoney = moneyAbs;
export const sumMoney = (values: readonly Money[]): Money => moneySum([...values]);
export const normalizeMoneyValue = (value: string): Money => normalizeMoney(value);
export const divideMoney = moneyDiv;
export const multiplyMoney = mulDecimal;
export const parseISO = (s: string) => new Date(s + "T00:00:00Z");
export const toISO = (d: Date) => d.toISOString().slice(0, 10);
// Date-shaped adapters over the platform civil-date arithmetic: the cash
// grid carries UTC-midnight Dates, the arithmetic itself lives in one place.
export const addDays = (d: Date, n: number) => parseIsoDate(addCalendarDays(toISO(d), n));
export const daysBetween = (a: Date, b: Date) => calendarDaysBetween(toISO(a), toISO(b));
/** Sunday of the week (date − getDay()). */
export const weekStart = (d: Date) => addDays(d, -d.getUTCDay());
/** Weekend → next business day (Sat +2, Sun +1). */
export const businessDay = (d: Date) => {
  const day = d.getUTCDay();
  if (day === 6) return addDays(d, 2);
  if (day === 0) return addDays(d, 1);
  return d;
};
export const weekLabel = (d: Date, locale = "en-US") => {
  const m = d.toLocaleString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  return m;
};

export type Side = "ar" | "ap";

export interface Bucket {
  label: string;
  amount: Money;
  /**
   * Position in the fixed aging ladder (0 = Current, 1 = 1–30, 2 = 31–60,
   * 3 = 61–90, 4 = 90+): readers select the bucket they mean by index,
   * never by position in the array or by matching the label, so a
   * relabelled bucket cannot hide past-due money in the current column.
   */
  index: number;
}

/**
 * Translate one category-history read's legs into presentation currency
 * BEFORE they are added together. Every leg carries its line entity's
 * functional currency and is translated at its bucket's latest posting date
 * (the rate in effect when the bucket's last flow posted) — the same rule
 * the customer profitability legs use. A missing rate refuses by name: a
 * multi-subsidiary history fails closed instead of fusing functionals raw,
 * exactly like the open-items forecast does. Returns translated amounts
 * aligned with the input legs; callers merge them per bucket.
 */
async function translateHistoryLegs(
  orgId: string,
  legs: { func: string | null; date: string; amount: string }[],
): Promise<string[]> {
  const ctx = await flowRates(
    orgId,
    legs.map((leg) => ({ func: leg.func, date: leg.date })),
  );
  return legs.map((leg) => mulDecimal(leg.amount, ctx.rateAt(leg.func, leg.date)));
}
export interface ForecastEntry {
  id: string;
  entryId: string;
  docKind: string | null;
  docNumber: string | null;
  docId: string | null;
  partyId: string | null;
  partyName: string;
  amount: Money;
  tranDate: string;
  dueDate: string | null;
  predictedDate: string;
  weekStart: string;
  daysOverdue: number;
  method: string;
}
export interface WeekRow {
  weekStart: string;
  weekEnd: string;
  label: string;
  inflow: Money;
  outflow: Money;
  net: Money;
  startingCash: Money;
  endingCash: Money;
  /**
   * The week's transactions. Omitted from a page's initial payload — a cockpit
   * ships thousands of these per week and renders them only when a week is
   * opened, so `weekForecastEntries` fetches the clicked week on demand.
   * Consumers that only need magnitudes must read the totals/counts below,
   * which are always populated.
   */
  arEntries: ForecastEntry[];
  apEntries: ForecastEntry[];
  /** Always present, even when the entry arrays have been withheld. */
  arTotal: Money;
  apTotal: Money;
  arCount: number;
  apCount: number;
  /** Non-AR/AP forecast flows from configured categories. */
  dynamicInflow: Money;
  dynamicOutflow: Money;
  /** AP scheduled but pushed to a later week by the capacity scheduler. */
  deferredOut: Money;
  /** Available AP capacity this week (null = unlimited, no scheduling). */
  apCapacity: Money | null;
}

/**
 * Non-AR/AP forecast category. All seven
 * calculation strategies are supported: GL History Average, Vendor Payment
 * History, Credit Card Cycle, Manual Recurring, Formula Expression, Vendor
 * Recurring (Auto) and Bank Register History — plus the expected-day /
 * expected-week placement (getProrationFactor).
 */
export type ForecastCategoryMethod =
  | "gl_history_average"
  | "vendor_payment_history"
  | "credit_card_cycle"
  | "manual_recurring"
  | "formula_expression"
  | "vendor_recurring_average"
  | "bank_register_history";

export interface ForecastCategory {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  method: ForecastCategoryMethod;
  /** Day-of-week (0=Sun…6=Sat) the flow lands on — '' / undefined = spread. */
  expectedDay?: number | string | null;
  /** Week-of-month (1–4) the flow lands in — '' / undefined = every week. */
  expectedWeek?: number | string | null;
  /** History window (weeks) — gl_history_average, bank_register_history. */
  historyWeeks?: number;
  /** History window (months) — vendor histories, credit_card_cycle. */
  historyMonths?: number;
  adjustmentPct?: number; // default 0
  // gl_history_average
  accountIds?: string[];
  /** Sum signed amounts (netting refunds) instead of gross per-line activity. */
  useNetAmt?: boolean;
  // vendor_payment_history / vendor_recurring_average
  partyId?: string;
  partyName?: string;
  partyIds?: string[];
  // credit_card_cycle
  cardAccountIds?: string[];
  significantPaymentThreshold?: string;
  // manual_recurring
  amount?: Money;
  frequency?: "weekly" | "biweekly" | "bi_weekly" | "monthly";
  /**
   * Persisted payment anchor (YYYY-MM-DD): a known occurrence the monthly /
   * biweekly schedules step from, so moving asOf never rephases them.
   * Rows predating the anchor backfill forecast from the horizon start.
   */
  anchorDate?: string;
  /**
   * Subsidiaries this category is attributed to. SQL-backed methods scope
   * through their accounts/parties, but manual and formula strategies are
   * org-level models: in a subsidiary-scoped view they show only when
   * attributed to a visible subsidiary, and hide otherwise (fail closed —
   * a restricted view must never show org-wide names and amounts).
   */
  subsidiaryIds?: string[];
  // formula_expression
  formula?: string;
  // bank_register_history
  bankAccountIds?: string[];
  memoKeywords?: string[];
  includeTransfers?: boolean;
  includeChecks?: boolean;
  includeJournals?: boolean;
}

/**
 * Context handed to the category engine: the AR/AP forecast totals per week
 * key and starting cash — the variables the formula strategy exposes
 * ({AR_IN}, {AP_OUT}, {NET_FLOW}, {CASH_START}).
 */
export interface CategoryContext {
  arWeekly: Record<string, Money>;
  apWeekly: Record<string, Money>;
  cashStart: Money;
  /**
   * The organization's forecast-model knobs. Loaders pass the resolved
   * config; direct callers may omit it and forecast on the spec defaults.
   */
  model?: ForecastModelParams;
  /** Active subsidiary view — SQL-backed strategies scope their history to it
   * (manual/formula strategies are org-level models and ignore it). */
  subIds?: string[];
  /**
   * Server-set: the caller is unrestricted AND the viewed set contains the
   * org root, so document-side histories also match root-owned (null
   * subsidiary) rows. Restricted callers never receive it.
   */
  includeNullSubsidiary?: boolean;
  /**
   * The org's fiscal year start month (1-12). Formula {QUARTER}/{IS_Q_START}/
   * {IS_Q_END}/{IS_YEAR_END} resolve on the fiscal calendar; omission falls
   * back to a January start.
   */
  fiscalStartMonth?: number;
}

/** A source item behind a category estimate (the breakdown rows). */
export interface CategoryBreakdownRow {
  name: string;
  date?: string;
  amount: Money;
  type: string;
  /** Extra context (payment counts, projection method, memo…). */
  details?: string;
}

export interface CategoryWeekly {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  method: ForecastCategory["method"];
  weekly: Money[]; // aligned with weeks[]
  total: Money;
  /** Human explanation of the computation (the Forecast Logic card). */
  logic: string;
  /** Display method label and the numbers behind the estimate. */
  meta: { method: string } & Record<string, string | number>;
  /** The source items the estimate was derived from. */
  breakdown: CategoryBreakdownRow[];
  /**
   * Set when the category refused to forecast: weekly[] is zeros and total
   * is zero, so the timeline still sums honestly, while the UI names the
   * reason instead of the figure. Absent = forecast as usual. The client
   * renders the catalog message selected by code with params — the English
   * message stays server-side for logs only, never rendered.
   */
  unavailable?: {
    code: "card-threshold-missing" | "missing-exchange-rate" | "formula-tax-unconfigured";
    message: string;
    params: Record<string, string | number>;
  };
}

/**
 * A forecast category's declared refusal: it names its own remedy and maps
 * to a per-category unavailable state in every loader, so one refusing
 * category never takes down the rest of the forecast. Anything else still
 * throws.
 */
export class CategoryForecastRefusal extends Error {
  readonly code = "card-threshold-missing" as const;
  readonly categoryId: string;
  readonly categoryName: string;
  constructor(categoryId: string, categoryName: string) {
    super(
      `credit card category "${categoryName}" has no payment history and no significant payment threshold — set one in the category editor so the forecast knows which payments count as the last payment`,
    );
    this.name = "CategoryForecastRefusal";
    this.categoryId = categoryId;
    this.categoryName = categoryName;
  }
}

/**
 * A formula category's tax refusal: {TAX_RATE} needs an enacted income tax
 * rate, resolved per attributed subsidiary. Unconfigured, or attributions
 * that disagree on the rate, refuse the category by name with the remedy —
 * a scoped unavailable state, never a whole-forecast failure.
 */
export class FormulaTaxRefusal extends Error {
  readonly code = "formula-tax-unconfigured" as const;
  readonly categoryId: string;
  readonly categoryName: string;
  constructor(categoryId: string, categoryName: string, detail: string) {
    super(
      `formula category "${categoryName}" ${detail} — set one at Setup → Taxes → Income tax rates`,
    );
    this.name = "FormulaTaxRefusal";
    this.categoryId = categoryId;
    this.categoryName = categoryName;
  }
}

/** A category that refused to forecast, for banners and tile hints. */
export type RefusedCategory = {
  id: string;
  name: string;
  code: "card-threshold-missing" | "missing-exchange-rate" | "formula-tax-unconfigured";
  message: string;
  params: Record<string, string | number>;
};

/** Every refusing category in a forecast, in forecast order. */
export function refusedCategories(categories: readonly CategoryWeekly[]): RefusedCategory[] {
  return categories.flatMap((c) =>
    c.unavailable ? [{ id: c.id, name: c.name, code: c.unavailable.code, message: c.unavailable.message, params: c.unavailable.params }] : [],
  );
}

/**
 * Map a category failure to its unavailable state, or null when the failure
 * is not a declared refusal (the caller rethrows those). Pure: unit-tested
 * without a database.
 */
export function toUnavailableCategory(
  cat: ForecastCategory,
  weekCount: number,
  e: unknown,
): CategoryWeekly | null {
  if (e instanceof CategoryForecastRefusal) {
    return {
      id: cat.id,
      name: cat.name,
      direction: cat.direction,
      method: cat.method,
      weekly: Array<Money>(weekCount).fill(ZERO_MONEY),
      total: ZERO_MONEY,
      logic: "",
      meta: { method: "Unavailable" },
      breakdown: [],
      unavailable: { code: e.code, message: e.message, params: { name: e.categoryName } },
    };
  }
  if (e instanceof MissingExchangeRateError) {
    return {
      id: cat.id,
      name: cat.name,
      direction: cat.direction,
      method: cat.method,
      weekly: Array<Money>(weekCount).fill(ZERO_MONEY),
      total: ZERO_MONEY,
      logic: "",
      meta: { method: "Unavailable" },
      breakdown: [],
      unavailable: {
        code: "missing-exchange-rate" as const,
        message: e.message,
        params: { func: e.func, base: e.base, date: e.date },
      },
    };
  }
  if (e instanceof FormulaTaxRefusal) {
    return {
      id: cat.id,
      name: cat.name,
      direction: cat.direction,
      method: cat.method,
      weekly: Array<Money>(weekCount).fill(ZERO_MONEY),
      total: ZERO_MONEY,
      logic: "",
      meta: { method: "Unavailable" },
      breakdown: [],
      unavailable: { code: e.code, message: e.message, params: { name: e.categoryName } },
    };
  }
  return null;
}

/**
 * One category's forecast with its declared refusals mapped to an
 * unavailable state: a refusing category contributes zeros to the timeline
 * and names its reason, while the rest of the forecast still renders.
 * Anything else still throws.
 */
export async function forecastCategoryOrUnavailable(
  orgId: string,
  cat: ForecastCategory,
  asOfIso: string,
  weekStarts: string[],
  context: CategoryContext,
  locale = "en-US",
): Promise<CategoryWeekly> {
  try {
    return await categoryWeekly(orgId, cat, asOfIso, weekStarts, context, locale);
  } catch (e) {
    const unavailable = toUnavailableCategory(cat, weekStarts.length, e);
    if (unavailable === null) throw e;
    return unavailable;
  }
}

export interface SideSummary {
  outstanding: Money;
  scheduled: Money; // amount predicted within the horizon
  /** Current-bucket share as an exact 0..1 ratio. */
  pctCurrent: Money;
  /** Mean days to settle behind the forecast (null = no payment history). */
  avgDays: number | null;
  buckets: Bucket[];
  /** Open items placed in NO week: no history and no due date to anchor to. */
  unplaced: { count: number; total: Money };
}

/**
 * The forecast-model knobs, resolved once per load from the cashflow
 * analytics config (see ANALYTICS_CONFIG.cashflow) and threaded through the
 * pure prediction below. Day counts and sigma multiples are model
 * coefficients (ordinary numbers); every monetary result stays exact.
 */
export interface ForecastModelParams {
  settleBufferSigma: number;
  overduePushShortDays: number;
  overduePushMidDays: number;
  overduePushLongDays: number;
  overdueMidThresholdDays: number;
  overdueLongThresholdDays: number;
  cardTrajectoryTolerance: number;
  cardMedianBlendWeight: number;
  vendorOutlierSigma: number;
  cardStatementCloseDays: number;
  cardDefaultPayDay: number;
  cardStalePaymentDays: number;
}

const CASHFLOW_MODEL_DEFAULTS: ForecastModelParams = {
  settleBufferSigma: ANALYTICS_CONFIG.cashflow.defaults.settleBufferSigma,
  overduePushShortDays: ANALYTICS_CONFIG.cashflow.defaults.overduePushShortDays,
  overduePushMidDays: ANALYTICS_CONFIG.cashflow.defaults.overduePushMidDays,
  overduePushLongDays: ANALYTICS_CONFIG.cashflow.defaults.overduePushLongDays,
  overdueMidThresholdDays: ANALYTICS_CONFIG.cashflow.defaults.overdueMidThresholdDays,
  overdueLongThresholdDays: ANALYTICS_CONFIG.cashflow.defaults.overdueLongThresholdDays,
  cardTrajectoryTolerance: ANALYTICS_CONFIG.cashflow.defaults.cardTrajectoryTolerance,
  cardMedianBlendWeight: ANALYTICS_CONFIG.cashflow.defaults.cardMedianBlendWeight,
  vendorOutlierSigma: ANALYTICS_CONFIG.cashflow.defaults.vendorOutlierSigma,
  cardStatementCloseDays: ANALYTICS_CONFIG.cashflow.defaults.cardStatementCloseDays,
  cardDefaultPayDay: ANALYTICS_CONFIG.cashflow.defaults.cardDefaultPayDay,
  cardStalePaymentDays: ANALYTICS_CONFIG.cashflow.defaults.cardStalePaymentDays,
};

/**
 * Fill a partial model (a test double's or a legacy read) with the spec
 * defaults, so every knob always has the organization's value. Explicit
 * undefined entries fall back too — a spread would let them shadow a default
 * with nothing.
 */
export function forecastModelParams(
  values: { [K in keyof ForecastModelParams]?: ForecastModelParams[K] | undefined },
): ForecastModelParams {
  return {
    settleBufferSigma: values.settleBufferSigma ?? CASHFLOW_MODEL_DEFAULTS.settleBufferSigma,
    overduePushShortDays: values.overduePushShortDays ?? CASHFLOW_MODEL_DEFAULTS.overduePushShortDays,
    overduePushMidDays: values.overduePushMidDays ?? CASHFLOW_MODEL_DEFAULTS.overduePushMidDays,
    overduePushLongDays: values.overduePushLongDays ?? CASHFLOW_MODEL_DEFAULTS.overduePushLongDays,
    overdueMidThresholdDays: values.overdueMidThresholdDays ?? CASHFLOW_MODEL_DEFAULTS.overdueMidThresholdDays,
    overdueLongThresholdDays: values.overdueLongThresholdDays ?? CASHFLOW_MODEL_DEFAULTS.overdueLongThresholdDays,
    cardTrajectoryTolerance: values.cardTrajectoryTolerance ?? CASHFLOW_MODEL_DEFAULTS.cardTrajectoryTolerance,
    cardMedianBlendWeight: values.cardMedianBlendWeight ?? CASHFLOW_MODEL_DEFAULTS.cardMedianBlendWeight,
    vendorOutlierSigma: values.vendorOutlierSigma ?? CASHFLOW_MODEL_DEFAULTS.vendorOutlierSigma,
    cardStatementCloseDays: values.cardStatementCloseDays ?? CASHFLOW_MODEL_DEFAULTS.cardStatementCloseDays,
    cardDefaultPayDay: values.cardDefaultPayDay ?? CASHFLOW_MODEL_DEFAULTS.cardDefaultPayDay,
    cardStalePaymentDays: values.cardStalePaymentDays ?? CASHFLOW_MODEL_DEFAULTS.cardStalePaymentDays,
  };
}

/** The organization's forecast-model knobs (one analytics-config read). */
export async function cashflowModel(orgId: string): Promise<ForecastModelParams> {
  return forecastModelParams(await analyticsConfig(orgId, "cashflow"));
}

/**
 * Blend a card's median payment with its current-cycle trajectory estimate.
 * The median takes the configured weight; the trajectory takes the exact
 * remainder — never a float subtraction (1 - 0.7 in binary is
 * 0.30000000000000004, which would corrupt the blend).
 */
export function blendTrajectoryPayment(median: Money, trajectory: Money, medianWeight: number): Money {
  const medianPart = multiplyMoney(median, String(medianWeight));
  const trajectoryPart = multiplyMoney(trajectory, subtractMoney("1", String(medianWeight)));
  return addMoney(medianPart, trajectoryPart);
}

/**
 * Square an outlier sigma multiple exactly: the variance filter compares
 * squared ratios, so a 2σ filter squares to 4 — computed in decimal, never
 * as a float product.
 */
export function outlierVarianceFactor(sigma: number): Money {
  const exact = String(sigma);
  return multiplyMoney(exact, exact);
}

/**
 * Exclude recurring-payment outliers beyond sigma measured standard
 * deviations: an amount is kept while its squared relative deviation stays
 * within variance × σ², where variance is the mean squared relative
 * deviation of the series itself. A tight series filters a 1.5× stray; a
 * wild one keeps it. Fewer than four samples, a non-positive mean, or zero
 * variance cannot filter — everything is kept. Exported for unit tests.
 */
export function filterRecurringOutliers(amounts: Money[], sigma: number): Money[] {
  if (amounts.length < 4) return amounts;
  const mean = divideMoney(sumMoney(amounts), String(amounts.length));
  if (compareMoney(mean, ZERO_MONEY) <= 0) return amounts;
  const relativeSquare = (amount: Money): Money => {
    const ratio = divideMoney(absMoney(subtractMoney(amount, mean)), mean);
    return multiplyMoney(ratio, ratio);
  };
  const variance = divideMoney(sumMoney(amounts.map(relativeSquare)), String(amounts.length));
  if (compareMoney(variance, ZERO_MONEY) <= 0) return amounts;
  const threshold = multiplyMoney(variance, outlierVarianceFactor(sigma));
  return amounts.filter((amount) => compareMoney(relativeSquare(amount), threshold) <= 0);
}

/** The trailing payment-history window, in months (one analytics-config read). */
export async function paymentHistoryMonths(orgId: string): Promise<number> {
  const cfg = await analyticsConfig(orgId, "cashflow");
  return cfg.paymentHistoryMonths ?? ANALYTICS_CONFIG.cashflow.defaults.paymentHistoryMonths;
}

export interface OpenItem {
  id: string;
  entryId: string;
  docKind: string | null;
  docNumber: string | null;
  docId: string | null;
  partyId: string | null;
  partyName: string;
  tranDate: Date;
  dueDate: Date | null;
  remaining: Money;
}

export type PaymentStats = { map: Map<string, { avg: number; sd: number; n: number }>; globalAvg: number | null };

/**
 * The same weeks with their per-transaction arrays withheld. Totals and counts
 * survive, so every summary still renders from the initial payload; the detail
 * is fetched per week when the reader opens one. Nothing is lost — only
 * deferred.
 */
export function withoutWeekEntries(weeks: WeekRow[]): WeekRow[] {
  return weeks.map((w) => ({ ...w, arEntries: [], apEntries: [] }));
}

/** A resolved week grid for a horizon anchored at `asOf`. */
export interface WeekGrid {
  asOfIso: string;
  asOf: Date;
  start: Date;
  end: Date;
  weekStarts: string[];
}

/** Build the Sunday-aligned week grid for a horizon (). */
export function buildWeekGrid(asOfIso: string, horizonWeeks: number): WeekGrid {
  const asOf = parseISO(asOfIso);
  const start = weekStart(asOf);
  const end = addDays(start, horizonWeeks * 7 - 1);
  const weekStarts: string[] = [];
  for (let cur = new Date(start); cur <= end; cur = addDays(cur, 7)) weekStarts.push(toISO(cur));
  return { asOfIso, asOf, start, end, weekStarts };
}

/** Clamp an as-of date to the organization's business day (never forecast from the future). */
export async function resolveAsOf(orgId: string, asOfDate?: string): Promise<string> {
  const today = await businessToday(orgId);
  return asOfDate && asOfDate < today ? asOfDate : today;
}

/**
 * Optional subsidiary scope — ` and <col> = any(ids)` when a subsidiary view
 * is active (the statement-matrix filter pattern). An omitted selection is
 * unrestricted; an explicit empty selection matches no subsidiary.
 */
function subScope(col: ReturnType<typeof sql>, subIds?: string[], includeNull = false) {
  if (subIds === undefined) return sql``;
  // The null limb is unrestricted-only and never widens an empty scope:
  // `= any('{}')` already matches nothing.
  if (includeNull && subIds.length > 0)
    return sql` and (${col} is null or ${col} = any(${`{${subIds.join(",")}}`}::uuid[]))`;
  return sql` and ${col} = any(${`{${subIds.join(",")}}`}::uuid[])`;
}

/**
 * Per-party avg days (+ σ) from invoice/bill date to the applied payment.
 * Forecast policy: history restricted to the trailing paymentHistoryMonths
 * (the cashflow analytics threshold, default 12), global average weighted by
 * data point (globalSum/globalCount over all payments, not an average of
 * per-party averages), and null when no history exists — never an invented
 * figure. Callers forecast history-less items at their due date, or leave
 * them unplaced when they carry none.
 */
export async function paymentStats(side: Side, asOfIso: string, subIds?: string[], orgId?: string): Promise<PaymentStats> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  // Settlement behaviour comes from party_payment_stats, the rollup maintained
  // at the settlement event (see 0001_baseline.sql). It stores sufficient
  // statistics per (party, settlement day) — count, Σdays, Σdays² — so the
  // trailing window is an exact range scan and both the mean and the
  // population standard deviation are reconstructed here without touching the
  // ledger. Deriving them from applications meant four joins over every
  // settlement in the tenant on every cockpit render.
  // Explicit orgId lets org-parameterized callers (analytics hubs) thread
  // their tenant through; ambient resolution keeps every existing caller.
  const resolvedOrgId = await resolveOrgId(orgId);
  // Exact calendar window: the trailing paymentHistoryMonths ending at asOf,
  // clamped to real month ends (Jan 31 looks back to Dec 31, not Dec 1).
  const historyStart = addMonthsClamped(asOfIso, -(await paymentHistoryMonths(resolvedOrgId)));
  // The company rollup intentionally has no entity dimension. Restricted
  // readers reconstruct the same sufficient statistics from visible source
  // and target lines, so another entity cannot influence their forecast.
  const source = subIds === undefined ? sql`
    select party_id, settled_on, n, sum_days, sum_days_sq
      from party_payment_stats
     where org_id = ${resolvedOrgId} and account_type = ${acctType}
       and settled_on >= ${historyStart}::date
       and settled_on <= ${asOfIso}::date
  ` : sql`
    select bl.party_id, pl.posting_date as settled_on, count(*) as n,
           sum((pl.posting_date - bl.posting_date)::numeric) as sum_days,
           sum(((pl.posting_date - bl.posting_date)::numeric)^2) as sum_days_sq
      from applications x
      join journal_lines bl on bl.id = x.to_line_id and bl.org_id = ${resolvedOrgId}
      join journal_lines pl on pl.id = x.from_line_id and pl.org_id = ${resolvedOrgId}
      join accounts a on a.id = bl.account_id and a.org_id = ${resolvedOrgId}
     where x.org_id = ${resolvedOrgId} and x.unapplied_at is null
       and bl.party_id is not null and bl.posting_date is not null
       and a.type = ${acctType}
       and pl.posting_date >= ${historyStart}::date
       and pl.posting_date <= ${asOfIso}::date
       ${subScope(sql`bl.subsidiary_id`, subIds)}
       ${subScope(sql`pl.subsidiary_id`, subIds)}
     group by bl.party_id, pl.posting_date
  `;
  const r = await analyticsQuery<{ id: string; avg_days: string; sd_days: string; n: string }>(sql`
    with stats as (${source})
    select party_id as id,
           sum(sum_days) / sum(n) as avg_days,
           sqrt(greatest(
             sum(sum_days_sq) / sum(n) - (sum(sum_days) / sum(n)) * (sum(sum_days) / sum(n)),
             0)) as sd_days,
           sum(n) as n
      from stats
     group by party_id
    having sum(n) > 0
  `);
  const map = new Map<string, { avg: number; sd: number; n: number }>();
  let sum = 0;
  let count = 0;
  for (const x of r.rows) {
    const avg = Number(x.avg_days);
    const n = Number(x.n);
    // n travels with the average so a reader can tell a mean over 40 settlements
    // from a mean over one; the sufficient statistics already carry it.
    map.set(x.id, { avg, sd: Number(x.sd_days), n });
    sum += avg * n;
    count += n;
  }
  // No history is null, never an invented figure: a new org's forecast must
  // say "no history", not "45 days".
  return { map, globalAvg: count > 0 ? Math.round(sum / count) : null };
}

/** Load configured categories from orgs.settings.analytics.cashflowCategories. */
export async function loadCategories(orgId: string): Promise<ForecastCategory[]> {
  const r = (await analyticsQuery(sql`
    select settings -> 'analytics' -> 'cashflowCategories' as cats from orgs where id = ${orgId}
  `));
  const raw = r.rows[0]?.cats;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => c && typeof c === "object" && c.id && c.name && c.method);
}

/**
 * Percent to exact decimal fraction — a decimal-point shift, never a
 * rounded money division: 21.125% prices 0.21125, not the 4-decimal 0.2113
 * a money division would round to. Canonical minimal form (no trailing
 * zeros); still an exact decimal string, never a float.
 */
export function percentToFractionExact(ratePercent: string): Money {
  const raw = ratePercent.trim();
  if (!/^\+?(\d+(\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`not a percent: "${ratePercent}"`);
  const unsigned = raw.replace(/^\+/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole.length - 2;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = `${digits}${"0".repeat(point - digits.length)}`;
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [w, f = ""] = out.split(".");
  const trimmed = f.replace(/0+$/, "");
  const wNorm = w.replace(/^0+(?=\d)/, "") || "0";
  return trimmed ? `${wNorm}.${trimmed}` : wNorm;
}

/**
 * Resolve the formula engine's tax fraction from the EFFECTIVE-DATED,
 * subsidiary-scoped income tax rate: the org-wide rows stacked with the
 * entity's own, as of the week being forecast. Null (nothing configured)
 * is a named refusal, never an assumed rate; the percent-to-fraction step
 * is exact decimal, never a rounded money division or a float /100.
 */
export async function resolveFormulaTaxRate(
  orgId: string,
  weekIso: string,
  subsidiaryId: string | null = null,
  taxReader: typeof enactedIncomeTaxRate = enactedIncomeTaxRate,
): Promise<Money> {
  const enacted = await taxReader(orgId, subsidiaryId, weekIso);
  if (enacted === null) {
    throw new Error(
      `formula {TAX_RATE} has no enacted income tax rate for organization ${orgId} on ${weekIso} — set one at Setup → Taxes → Income tax rates`,
    );
  }
  return percentToFractionExact(enacted.ratePercent);
}

/**
 * The formula engine's tax fraction for one category and week, resolved per
 * attributed subsidiary: an unattributed category prices the org-wide
 * stack, an attributed one prices each attributed subsidiary's stack, and
 * attributions that disagree on the rate refuse the category by name.
 * Anything unconfigured refuses the category (a scoped unavailable state
 * through forecastCategoryOrUnavailable) — never the whole forecast.
 */
export async function resolveFormulaTaxRateForCategory(
  orgId: string,
  cat: ForecastCategory,
  weekIso: string,
  taxReader: typeof enactedIncomeTaxRate = enactedIncomeTaxRate,
): Promise<Money> {
  const attributed = cat.subsidiaryIds ?? [];
  const scopes = attributed.length > 0 ? attributed : [null];
  const enacted = await Promise.all(scopes.map((s) => taxReader(orgId, s, weekIso)));
  const missing = scopes.filter((_, i) => enacted[i] === null);
  if (missing.length > 0) {
    const where = missing.map((s) => (s === null ? `organization ${orgId}` : `subsidiary ${s}`)).join(", ");
    throw new FormulaTaxRefusal(cat.id, cat.name, `has no enacted income tax rate for ${where} on ${weekIso}`);
  }
  const rates = enacted.map((e) => e!.ratePercent);
  if (new Set(rates).size > 1) {
    throw new FormulaTaxRefusal(
      cat.id,
      cat.name,
      `is attributed to subsidiaries with different enacted income tax rates (${[...new Set(rates)].join(", ")}%) on ${weekIso}`,
    );
  }
  return percentToFractionExact(rates[0]!);
}

/* ------------------- category engine helpers ------------------------------- */

const addMonthsUTC = (d: Date, n: number): Date => parseIsoDate(addMonthsClamped(toISO(d), n));

/** Strict YYYY-MM-DD anchor: a real calendar date, or null for legacy rows. */
export function parseAnchorDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) return null;
  if (d! > daysInCivilMonth(y!, m!)) return null;
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999 (an 0096 anchor used to fail validation as "not real").
  const roundTrip = utcDateFromParts(y!, m! - 1, d!);
  if (
    roundTrip.getUTCFullYear() !== y! ||
    roundTrip.getUTCMonth() !== m! - 1 ||
    roundTrip.getUTCDate() !== d!
  ) return null;
  return value;
}

/**
 * Monthly occurrence dates of an anchored schedule inside [fromIso, toIso].
 * Forward months step through billing/cadence.ts's advanceAnchoredMonth (the
 * shared anchored step: Jan 31 → Feb 28 → Mar 31, never drifting to Mar 28);
 * months before the anchor month clamp through platform daysInCivilMonth,
 * since advanceAnchoredMonth only steps forward.
 */
export function anchoredMonthlyOccurrences(anchorIso: string, fromIso: string, toIso: string): string[] {
  const [ay, amo, aday] = anchorIso.split("-").map(Number) as [number, number, number];
  const anchorIdx = ay * 12 + amo;
  const [fy, fmo] = fromIso.split("-").map(Number) as [number, number];
  const [ty, tmo] = toIso.split("-").map(Number) as [number, number];
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const out: string[] = [];
  for (let m = fy * 12 + fmo - 1; m <= ty * 12 + tmo + 1; m++) {
    let iso: string;
    if (m === anchorIdx) iso = anchorIso;
    else if (m > anchorIdx) iso = advanceAnchoredMonth(ay, amo, m - anchorIdx, aday);
    else {
      const yy = Math.floor((m - 1) / 12);
      const mm = ((m - 1) % 12) + 1;
      iso = `${pad(yy, 4)}-${pad(mm, 2)}-${pad(Math.min(aday, daysInCivilMonth(yy, mm)), 2)}`;
    }
    if (iso >= fromIso && iso <= toIso) out.push(iso);
  }
  return out;
}
// daysInCivilMonth keeps literal years 0001-0099 that Date.UTC would remap
// onto 1900-1999.
const daysInMonthUTC = (d: Date): number => daysInCivilMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);

/**
 * Spread one month's amount across a forecast week using the ACTUAL calendar
 * month the week starts in (7 ÷ month days) — never the fixed 4.345-week
 * average, which prices January like February. One exact-decimal rounding.
 */
export const spreadMonthlyOverWeek = (monthly: Money, weekStartIso: string): Money =>
  divideMoney(multiplyMoney(monthly, "7"), String(daysInMonthUTC(parseISO(weekStartIso))));

/**
 * The inverse direction: place one week's amount as a whole month's worth in
 * a monthly-placement week (month days ÷ 7). Used where the forecast lands a
 * weekly average on a month boundary — never where a monthly figure spreads
 * across weeks.
 */
export const spreadWeeklyOverMonth = (weekly: Money, weekStartIso: string): Money =>
  divideMoney(multiplyMoney(weekly, String(daysInMonthUTC(parseISO(weekStartIso)))), "7");

/**
 * Fiscal quarter flags for one forecast week, for formula {QUARTER}/
 * {IS_Q_START}/{IS_Q_END}/{IS_YEAR_END}. The offset counts months from the
 * org's fiscal year start — never calendar quarters. Exported for unit tests;
 * callers pass the already-computed month-boundary flags.
 */
export function fiscalFormulaFlags(
  weekStartIso: string,
  fiscalStart: number,
  isMonthStart: number,
  isMonthEnd: number,
): { quarter: number; isQStart: number; isQEnd: number; isYearEnd: number } {
  const offset = fiscalMonthOffset(weekStartIso, fiscalStart);
  return {
    quarter: Math.floor(offset / 3) + 1,
    isQStart: offset % 3 === 0 && isMonthStart === 1 ? 1 : 0,
    isQEnd: offset % 3 === 2 && isMonthEnd === 1 ? 1 : 0,
    isYearEnd: offset === 11 && isMonthEnd === 1 ? 1 : 0,
  };
}
const isSet = (v: number | string | null | undefined): boolean => v !== null && v !== undefined && v !== "";

/**
 * Whether a category may appear in front of a caller. SQL-backed methods
 * scope through their own accounts/parties, so they always pass here, and
 * unrestricted callers see everything (as today — narrowing a view never
 * hides what the caller may read org-wide). Manual and formula strategies
 * are org-level models that ignore subIds, so for RESTRICTED callers they
 * show only when attributed to a visible subsidiary: an unattributed one
 * hides (fail closed) rather than leaking org-wide names and amounts into
 * a view the reader must not see beyond.
 */
export function isCategoryVisibleInScope(
  cat: ForecastCategory,
  subIds: string[] | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): boolean {
  if (subIds === undefined || allowedSubsidiaryIds === null) return true;
  if (cat.method !== "manual_recurring" && cat.method !== "formula_expression") return true;
  const attributed = cat.subsidiaryIds ?? [];
  return attributed.some((id) => subIds.includes(id));
}

/**
 * How many history weeks an average divides by: the week buckets of the
 * historyWeeks-long window ending at asOf that fall on or after the
 * strategy's data start. The data start is the strategy's earliest posted
 * activity in its own read scope, clamped into the window (a missing start
 * means a full window). Zero-activity weeks after that start still count;
 * weeks before it predate the books and must not dilute the run-rate — but
 * a young org with 3 weeks of books in a 12-week window divides by 3, not
 * by 1 (a single active week) and not by 12. Always within [1, historyWeeks].
 * Shared by the GL-history and bank-register strategies.
 */
export function historyWindowDivisor(
  historyWeeks: number,
  windowStartIso: string,
  dataStartIso: string | null,
): number {
  const weeks = Math.max(1, Math.min(52, Math.floor(Number(historyWeeks) || 0)));
  const windowStart = parseISO(windowStartIso);
  const effective =
    dataStartIso && dataStartIso > windowStartIso ? parseISO(dataStartIso) : windowStart;
  // Buckets are the Sundays windowStart + 7k; a bucket counts when its week
  // (Sunday..Saturday) reaches the effective start.
  const skip = Math.max(0, Math.ceil((daysBetween(windowStart, effective) - 6) / 7));
  return Math.min(weeks, Math.max(1, weeks - skip));
}

/**
 * Weekly average over the history window (see historyWindowDivisor).
 * Shared by the GL-history and bank-register strategies.
 */
export function fullWindowWeeklyAverage(
  total: Money,
  historyWeeks: number,
  windowStartIso: string,
  dataStartIso: string | null,
): Money {
  return divideMoney(total, String(historyWindowDivisor(historyWeeks, windowStartIso, dataStartIso)));
}

/**
 * Normal-balance conventions, DERIVED from the canonical class map in
 * engine/src/records/account-types.ts — never a second handwritten list.
 * A type the map gains tomorrow joins a convention here automatically; a
 * handwritten copy would silently miss it (or throw and break every
 * forecast for the org).
 */
const DEBIT_NORMAL_TYPES: ReadonlySet<string> = new Set([
  ...ACCOUNT_CLASS_TYPES.asset,
  ...ACCOUNT_CLASS_TYPES.expense,
]);

/** Credit-normal classes from the same canonical map. */
const CREDIT_NORMAL_TYPES: ReadonlySet<string> = new Set([
  ...ACCOUNT_CLASS_TYPES.liability,
  ...ACCOUNT_CLASS_TYPES.equity,
  ...ACCOUNT_CLASS_TYPES.income,
]);

/**
 * Resolve one normal-balance convention (+1 debit-normal, -1 credit-normal)
 * for a category's accounts from their gross activity: the convention
 * carrying the larger gross wins, so a contra account never outvotes its
 * primary; an exact tie follows the first-listed account (operator control).
 * An unmapped type refuses by name instead of guessing a sign.
 */
export function netConvention(
  accounts: readonly { id: string; type: string; gross: Money }[],
): 1 | -1 {
  // No activity: the netted total is zero and the convention is never read.
  if (accounts.length === 0) return 1;
  let debitGross = ZERO_MONEY;
  let creditGross = ZERO_MONEY;
  for (const account of accounts) {
    if (DEBIT_NORMAL_TYPES.has(account.type)) {
      debitGross = addMoney(debitGross, absMoney(account.gross));
    } else if (CREDIT_NORMAL_TYPES.has(account.type)) {
      creditGross = addMoney(creditGross, absMoney(account.gross));
    } else {
      throw new Error(
        `cash forecast net orientation meets unknown account type "${account.type}": map it to a normal balance before forecasting`,
      );
    }
  }
  if (compareMoney(debitGross, creditGross) === 0) {
    const first = accounts[0]?.type;
    if (first !== undefined && CREDIT_NORMAL_TYPES.has(first)) return -1;
    return 1;
  }
  return compareMoney(debitGross, creditGross) > 0 ? 1 : -1;
}

/**
 * Orient a SIGNED netted total once, by the accounts' normal-balance
 * convention: activity on the convention's side is the forecast magnitude
 * (debit-positive expense legs are outflow; credit-negative legs on
 * credit-normal accounts are flipped to it). A total running against the
 * convention (net refunds over the window) forecasts 0 — reported with a
 * visible note, never as cash in the wrong direction.
 */
export function orientNetTotal(
  total: Money,
  convention: 1 | -1,
): { total: Money; againstDirection: boolean } {
  if (compareMoney(total, ZERO_MONEY) === 0) return { total: ZERO_MONEY, againstDirection: false };
  if (compareMoney(total, ZERO_MONEY) === convention) {
    return { total: absMoney(total), againstDirection: false };
  }
  return { total: ZERO_MONEY, againstDirection: true };
}

/**
 *  — places a weekly amount on its expected day of
 * week / week of month, zeroes weeks whose slot has already passed, and
 * prorates the current distributed week by business days remaining.
 */
export function getProrationFactor(
  weekStartDate: Date,
  asOf: Date,
  expectedDay?: number | string | null,
  expectedWeek?: number | string | null,
): number {
  const wStart = weekStartDate;
  let targetDate = new Date(wStart);
  let isSpecificDay = false;

  if (isSet(expectedDay)) {
    isSpecificDay = true;
    const distance = Number(expectedDay) - wStart.getUTCDay();
    targetDate = addDays(wStart, distance);
  }

  if (isSet(expectedWeek)) {
    const dayOfMonth = targetDate.getUTCDate();
    const targetWk = Number(expectedWeek);
    const actualWk = Math.ceil(dayOfMonth / 7);
    const isMatch = (targetWk === 4 && dayOfMonth >= 22) || targetWk === actualWk;
    if (!isMatch) return 0;
  }

  if (isSpecificDay) return targetDate < asOf ? 0 : 1;
  if (isSet(expectedWeek)) return addDays(wStart, 6) < asOf ? 0 : 1;
  if (wStart > asOf) return 1;

  const weekEnd = addDays(wStart, 6);
  let loopDate = new Date(asOf);
  if (loopDate > weekEnd) return 0;
  if (loopDate < wStart) loopDate = new Date(wStart);
  let businessDaysRemaining = 0;
  while (loopDate <= weekEnd) {
    const day = loopDate.getUTCDay();
    if (day >= 1 && day <= 5) businessDaysRemaining++;
    loopDate = addDays(loopDate, 1);
  }
  return Math.min(Math.max(businessDaysRemaining / 5, 0), 1);
}

/**
 * Compute one category's weekly amounts across the horizon — ALL SEVEN of
 * the strategies (Lib_Cashflow_Data processCategory), ported faithfully:
 *
 *  - gl_history_average: weekly GL activity average over historyWeeks, actuals
 *    override forecast inside the horizon, optional net-amount mode.
 *  - vendor_payment_history: median non-zero monthly outflow to the vendors,
 *    spread by each week's actual calendar month length (or placed monthly
 *    when an expected week is set).
 *  - credit_card_cycle: statement-cycle model — detected payment day, median
 *    completed-month payment, current balance + burn-rate trajectory blend.
 *  - manual_recurring: fixed amount stepped weekly / bi-weekly / monthly.
 *  - formula_expression: Excel-style formula over {AR_IN}/{AP_OUT}/{NET_FLOW}/
 *    {CASH_START}/{WEEK_NUM}/fiscal-calendar flags, evaluated safely per week.
 *  - vendor_recurring_average: auto-detected payment cadence (median interval,
 *    2σ outlier filter) scheduled forward from the last payment.
 *  - bank_register_history: average of actual bank cash-out by week, filtered
 *    by document kind and memo keywords, current-week actuals netted off.
 *
 * Expected-day / expected-week placement applies via getProrationFactor.
 */
export async function categoryWeekly(
  orgId: string,
  cat: ForecastCategory,
  asOfIso: string,
  weekStarts: string[],
  context: CategoryContext,
  /**
   * Viewer BCP-47 locale for breakdown month names (F2-14b). UI readers pass
   * the request locale; the default serves the engine unit tests and the
   * label-agnostic agent-tool callers, matching the position
   * readers. See scripts/check-viewer-locale.allowlist.json.
   */
  locale = "en-US",
): Promise<CategoryWeekly> {
  const { money } = await getMoneyFormatter(orgId)
  const n = weekStarts.length;
  // Strategy implementations use ordinary numbers for non-ledger model
  // coefficients (proration, cadence), but every monetary result is
  // canonicalized to a four-decimal string at this function's return
  // boundary. SQL money values are never exposed as a JavaScript Number, and
  // formula evaluation is exact decimal end to end (see ./formula): the
  // evaluator returns a canonical numeric(19,4) string, never a float.
  const weekly = new Array<Money>(n).fill(ZERO_MONEY);
  const weeklyExact = new Array<Money | null>(n).fill(null);
  // The forecast-model knobs ride the context the loaders resolved — one
  // config read per load, not one per category — with the spec defaults
  // behind direct callers that never resolved one.
  const model = forecastModelParams(context.model ?? {});
  const asOf = parseISO(asOfIso);
  const tStart = parseISO(weekStarts[0]!);
  const tEnd = addDays(parseISO(weekStarts[n - 1]!), 6);
  const adj = (cat.adjustmentPct ?? 0) / 100;
  let logic = "";
  let meta: CategoryWeekly["meta"] = { method: "Unknown" };
  let breakdown: CategoryBreakdownRow[] = [];
  const wkIndex = new Map(weekStarts.map((w, i) => [w, i]));

  if (cat.method === "manual_recurring") {
    const amount = absMoney(normalizeMoneyValue(cat.amount ?? ZERO_MONEY));
    // Legacy rows saved before the frequency refusal carry none: they keep
    // forecasting monthly, exactly as before. Every save since names one.
    const freqRaw = cat.frequency ?? "monthly";
    const freq = freqRaw === "bi_weekly" ? "biweekly" : freqRaw;
    // A persisted anchor pins the phase: monthly/biweekly occurrences step
    // from it, so moving asOf never rephases the schedule. Weekly amounts
    // spread across the week (no phase to pin) and anchorless legacy rows
    // keep stepping from the horizon start.
    const anchorIso = freq === "weekly" ? null : parseAnchorDate(cat.anchorDate);
    const occurrences: Date[] = [];
    if (anchorIso === null) {
      let curr = new Date(tStart);
      while (curr <= tEnd) {
        occurrences.push(curr);
        if (freq === "monthly") curr = addMonthsUTC(curr, 1);
        else if (freq === "biweekly") curr = addDays(curr, 14);
        else curr = addDays(curr, 7);
      }
    } else if (freq === "biweekly") {
      const anchor = parseISO(anchorIso);
      const gapDays = daysBetween(anchor, asOf);
      let curr = addDays(anchor, Math.floor(gapDays / 14) * 14);
      while (curr < asOf) curr = addDays(curr, 14);
      while (curr <= tEnd) {
        occurrences.push(curr);
        curr = addDays(curr, 14);
      }
    } else {
      for (const iso of anchoredMonthlyOccurrences(anchorIso, toISO(asOf), toISO(tEnd))) {
        occurrences.push(parseISO(iso));
      }
    }
    for (const curr of occurrences) {
      const wk = toISO(weekStart(curr));
      // Weekly amounts spread across the week, so the current week prorates
      // by business days remaining. Monthly/biweekly occurrences are discrete
      // payment dates: one before asOf is already paid history, so it must
      // not land in the forecast or the paid bill double-counts as future
      // cash need.
      const pastOccurrence = freq !== "weekly" && curr < asOf;
      if (!pastOccurrence) {
        const currentAmount = freq === "weekly"
          ? multiplyMoney(amount, String(getProrationFactor(curr, asOf, null, null)))
          : amount;
        const i = wkIndex.get(wk);
        if (i !== undefined) weeklyExact[i] = addMoney(weeklyExact[i] ?? ZERO_MONEY, currentAmount);
      }
    }
    logic = `${money(amount, { maximumFractionDigits: 0 })} ${freq}`;
    meta = { method: "Manual Recurring", amount, frequency: freq };
    breakdown = weekStarts
      .map((w, i) => ({ name: `Manual (${freq})`, date: w, amount: weeklyExact[i] ?? ZERO_MONEY, type: "Scheduled" }))
      .filter((row) => compareMoney(String(row.amount), ZERO_MONEY) > 0);
  } else if (cat.method === "gl_history_average" && cat.accountIds?.length) {
    const historyWeeks = Math.max(1, Math.min(52, cat.historyWeeks ?? 12));
    const useNet = cat.useNetAmt === true;
    const ids = sql.join(cat.accountIds.map((a) => sql`${a}`), sql`, `);
    const historyStart = addDays(tStart, -historyWeeks * 7);
    // Grouped by Sunday-start week AND account: weeks before the horizon feed
    // the average, weeks inside it act as actuals (). History is cut at
    // asOf: postings after the forecast date must not leak into a historical
    // forecast, so only the current (partial) week can carry actuals.
    const r = (await analyticsQuery<CashWeeklyHistoryRow>(sql`
      -- Legs are stamped in their line entity's functional: carry it (and the
      -- bucket's latest posting date) so the merge below translates every leg
      -- into presentation currency BEFORE adding. Raw sums across
      -- subsidiaries would fuse functionals the forecast keeps separate.
      select (e.posting_date - extract(dow from e.posting_date)::int)::text as wk,
             a.number, a.name, sub.base_currency as func,
             sum(l.amount) as net, sum(abs(l.amount)) as gross,
             max(e.posting_date)::text as late
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join subsidiaries sub on sub.id = l.subsidiary_id
      where l.org_id = ${orgId} and l.account_id in (${ids})
        and e.posting_date >= ${toISO(historyStart)} and e.posting_date <= ${asOfIso}${subScope(sql`l.subsidiary_id`, context.subIds)}
      group by 1, a.number, a.name, sub.base_currency
    `));
    const translatedNet = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.late), amount: normalizeMoneyValue(String(x.net)) })),
    );
    const translatedGross = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.late), amount: normalizeMoneyValue(String(x.gross)) })),
    );
    const weeklyHistory: Record<string, Money> = {};
    const accountTotals = new Map<string, Money>();
    r.rows.forEach((x, i) => {
      // Net mode keeps rows SIGNED through the weekly and window sums so
      // refunds offset spend and contra accounts offset their primaries.
      // Orientation happens once, on the netted total, below.
      const activity = useNet ? translatedNet[i]! : translatedGross[i]!;
      weeklyHistory[x.wk] = addMoney(weeklyHistory[x.wk] ?? ZERO_MONEY, activity);
      const label = [x.number, x.name].filter(Boolean).join(" · ");
      // Signed like the forecast series, so the source rows tie to the
      // netted total they explain.
      accountTotals.set(label, addMoney(accountTotals.get(label) ?? ZERO_MONEY, activity));
    });
    let totalHistory = ZERO_MONEY;
    const startKey = toISO(tStart);
    for (const k of Object.keys(weeklyHistory)) {
      if (k < startKey) { totalHistory = addMoney(totalHistory, weeklyHistory[k]!); }
    }
    // The data start is the earliest posting in this strategy's own read
    // scope (same accounts, book, and subsidiary filter as the history
    // above — just unbounded in time), so a young org divides by its weeks
    // of books instead of the full window. The same query carries each
    // account's type and gross, which net mode needs to resolve one
    // normal-balance convention for the orientation below.
    const windowStartIso = toISO(historyStart);
    const scopeRows = (await analyticsQuery<{ d: string | null; id: string; type: string; gross: string; func: string | null }>(sql`
      select min(e.posting_date)::text as d, a.id::text as id, a.type as type, sum(abs(l.amount)) as gross, sub.base_currency as func
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
        join subsidiaries sub on sub.id = l.subsidiary_id
       where l.org_id = ${orgId} and l.account_id in (${ids})${subScope(sql`l.subsidiary_id`, context.subIds)}
       group by a.id, a.type, sub.base_currency
    `));
    // Lifetime activity has no bucket date: translate every leg at the
    // forecast date (today's rate for a lifetime total) before the merge.
    const scopeTranslated = await translateHistoryLegs(
      orgId,
      scopeRows.rows.map((row) => ({ func: row.func, date: asOfIso, amount: normalizeMoneyValue(String(row.gross)) })),
    );
    const scopeMerged = new Map<string, { d: string | null; type: string; gross: Money }>();
    scopeRows.rows.forEach((row, i) => {
      const cur = scopeMerged.get(row.id) ?? { d: null, type: row.type, gross: ZERO_MONEY };
      if (row.d !== null && (cur.d === null || row.d < cur.d)) cur.d = row.d;
      cur.gross = addMoney(cur.gross, scopeTranslated[i]!);
      scopeMerged.set(row.id, cur);
    });
    const dataStartIso = [...scopeMerged.values()].reduce<string | null>(
      (earliest, row) => (row.d !== null && (earliest === null || row.d < earliest) ? row.d : earliest),
      null,
    );
    const divisor = historyWindowDivisor(historyWeeks, windowStartIso, dataStartIso);
    // Convention votes come only from accounts WITH activity (a selected
    // account that never posted must not refuse the forecast); the
    // accountIds order breaks exact ties. Gross is the translated merge, so
    // a foreign-functional account votes with its presentation weight.
    const voted = cat.accountIds.flatMap((id) => {
      const row = scopeMerged.get(id);
      return row
        ? [{ id, type: row.type, gross: row.gross }]
        : [];
    });
    const oriented = useNet
      ? orientNetTotal(totalHistory, netConvention(voted))
      : { total: absMoney(totalHistory), againstDirection: false };
    let weeklyAvg = fullWindowWeeklyAverage(oriented.total, historyWeeks, windowStartIso, dataStartIso);
    if (adj !== 0) weeklyAvg = multiplyMoney(weeklyAvg, String(1 + adj));
    weekStarts.forEach((k, i) => {
      const actual = weeklyHistory[k] ?? ZERO_MONEY;
      // A monthly placement lands the week's average as a whole month's worth.
      const forecastAmount = isSet(cat.expectedWeek) ? spreadWeeklyOverMonth(weeklyAvg, k) : weeklyAvg;
      const amount = compareMoney(actual, ZERO_MONEY) > 0 ? actual : forecastAmount;
      const factor = getProrationFactor(parseISO(k), asOf, cat.expectedDay, cat.expectedWeek);
      weeklyExact[i] = multiplyMoney(amount, String(factor));
    });
    logic = `${historyWeeks}-week GL average${adj ? ` ${adj > 0 ? "+" : ""}${Math.round(adj * 100)}%` : ""} across ${cat.accountIds.length} account${cat.accountIds.length === 1 ? "" : "s"}`;
    meta = {
      method: "GL Average",
      sourceTotal: absMoney(totalHistory),
      weeksUsed: divisor,
      rawAverage: fullWindowWeeklyAverage(oriented.total, historyWeeks, windowStartIso, dataStartIso),
      adjustmentPct: Math.round(adj * 100),
      finalAverage: weeklyAvg,
    };
    breakdown = [...accountTotals.entries()]
      .map(([name, amount]) => ({ name, amount, type: "Source Data" }))
      .sort((a, b) => compareMoney(b.amount, a.amount));
    if (oriented.againstDirection) {
      // The netted window runs against the forecast direction (net refunds
      // in an outflow category, net spend in an inflow one): forecast 0 and
      // say so on the card, naming the net that was set aside, rather than
      // letting it add cash in the wrong direction.
      const note =
        `netted ${totalHistory} runs against the ${cat.direction} direction — forecast 0; recheck the selected accounts`;
      logic = `${logic} · ${note}`;
      breakdown.push({ name: note, amount: ZERO_MONEY, type: "Note" });
    }
  } else if (cat.method === "vendor_payment_history" && (cat.partyIds?.length || cat.partyId)) {
    const vids = cat.partyIds?.length ? cat.partyIds : [cat.partyId!];
    const historyMonths = Math.max(1, Math.min(36, cat.historyMonths ?? 12));
    const idList = sql.join(vids.map((v) => sql`${v}`), sql`, `);
    const r = (await analyticsQuery<{ month: string; func: string | null; paid: string; late: string }>(sql`
      -- documents.total is transaction-currency denominated: translate at the
      -- document FX rate into functional currency before adding, exactly like
      -- the purchasing paid values do. The functional leg is carried (with
      -- the month's latest document date) so the merge below translates every
      -- subsidiary into presentation currency BEFORE adding — raw sums would
      -- fuse functionals the forecast keeps separate.
      select to_char(coalesce(d.document_date, d.posting_date), 'YYYY-MM') as month, sub.base_currency as func,
             sum(round(abs(d.total * d.fx_rate), 4)) as paid,
             max(coalesce(d.document_date, d.posting_date))::text as late
      from documents d
      -- Root-owned documents carry no subsidiary: a left join keeps them
      -- (their null functional maps to the org base at translation time)
      -- instead of silently dropping their payments from the history.
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      where d.org_id = ${orgId} and d.party_id in (${idList}) and d.voided_at is null
        and d.kind in ('vendor_payment', 'check')
        and coalesce(d.document_date, d.posting_date) > ${asOfIso}::date - (${historyMonths} || ' months')::interval
        and coalesce(d.document_date, d.posting_date) <= ${asOfIso}::date${subScope(sql`d.subsidiary_id`, context.subIds, context.includeNullSubsidiary === true)}
      group by 1, 2
    `));
    const translatedPaid = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.late), amount: normalizeMoneyValue(String(x.paid)) })),
    );
    const monthlyTotals = new Map<string, Money>();
    r.rows.forEach((x, i) => {
      const month = String(x.month);
      monthlyTotals.set(month, addMoney(monthlyTotals.get(month) ?? ZERO_MONEY, translatedPaid[i]!));
    });
    const months = [...monthlyTotals.values()].filter((v) => compareMoney(v, ZERO_MONEY) > 0).sort(compareMoney);
    const mid = Math.floor(months.length / 2);
    const median = months.length ? (months.length % 2 !== 0 ? months[mid]! : divideMoney(addMoney(months[mid - 1]!, months[mid]!), "2")) : ZERO_MONEY;
    // Without an expected week the monthly median spreads across each week's
    // own calendar month; the card's weekly equivalent is the horizon mean of
    // those scaled weeks (post-adjustment, pre-proration).
    let scaledSum = ZERO_MONEY;
    weekStarts.forEach((k, i) => {
      const scaled = isSet(cat.expectedWeek) ? median : spreadMonthlyOverWeek(median, k);
      const baseAmount = adj !== 0 ? multiplyMoney(scaled, String(1 + adj)) : scaled;
      scaledSum = addMoney(scaledSum, baseAmount);
      weeklyExact[i] = multiplyMoney(baseAmount, String(getProrationFactor(parseISO(k), asOf, cat.expectedDay, cat.expectedWeek)));
    });
    logic = `median of ${months.length} monthly payments${isSet(cat.expectedWeek) ? "" : ", spread by actual month length"}`;
    meta = {
      method: "Vendor History (Median)",
      monthlyMedian: median,
      finalWeekly: weekStarts.length ? divideMoney(scaledSum, String(weekStarts.length)) : ZERO_MONEY,
      vendors: vids.length,
      ...(cat.partyName ? { vendor: cat.partyName } : {}),
    };
    breakdown = [...monthlyTotals.entries()]
      .map(([month, amount]) => ({ name: month, amount, type: "Source Month" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else if (cat.method === "credit_card_cycle" && (cat.cardAccountIds?.length || cat.accountIds?.length)) {
    const accountIds = cat.cardAccountIds?.length ? cat.cardAccountIds : cat.accountIds!;
    const lookbackMonths = Math.max(1, Math.min(24, cat.historyMonths ?? 6));
    // The window opens an exact calendar span before the forecast date — the
    // day count comes from the dates involved, never 30-day months.
    const historyStartIso = addMonthsClamped(asOfIso, -lookbackMonths);
    const lookbackDays = Math.max(1, calendarDaysBetween(historyStartIso, asOfIso));
    const historyStart = parseISO(historyStartIso);
    const ids = sql.join(accountIds.map((a) => sql`${a}`), sql`, `);
    // Charges push the card liability (amount < 0), payments release it (> 0).
    // Legs carry their functional currency: each (day, functional) leg is
    // translated at its day BEFORE the merge, so two subsidiaries' card
    // activity never adds raw.
    const r = (await analyticsQuery<CashDailyRow>(sql`
      select e.posting_date::text as day, sub.base_currency as func,
             sum(case when l.amount < 0 then -l.amount else 0 end) as spend,
             sum(case when l.amount > 0 then l.amount else 0 end) as paid
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
        and e.book_id = ${statementBookExpr(orgId)}
      join subsidiaries sub on sub.id = l.subsidiary_id
      where l.org_id = ${orgId} and l.account_id in (${ids})
        and e.posting_date >= ${toISO(historyStart)} and e.posting_date <= ${asOfIso}${subScope(sql`l.subsidiary_id`, context.subIds)}
      group by 1, 2
    `));
    const translatedSpend = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.day), amount: normalizeMoneyValue(String(x.spend)) })),
    );
    const translatedPaid = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.day), amount: normalizeMoneyValue(String(x.paid)) })),
    );
    const balR = (await analyticsQuery<{ func: string | null; bal: string }>(sql`
      select sub.base_currency as func, coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
        and e.book_id = ${statementBookExpr(orgId)}
      join subsidiaries sub on sub.id = l.subsidiary_id
      where l.org_id = ${orgId} and l.account_id in (${ids}) and e.posting_date <= ${asOfIso}${subScope(sql`l.subsidiary_id`, context.subIds)}
      group by 1
    `));
    // A point-in-time stock has no flow date: translate every functional
    // balance at the forecast date before adding.
    const translatedBal = await translateHistoryLegs(
      orgId,
      balR.rows.map((x) => ({ func: x.func, date: asOfIso, amount: normalizeMoneyValue(String(x.bal)) })),
    );
    const totalCurrentBalance = absMoney(sumMoney(translatedBal));

    interface DayTotals { date: Date; spend: Money; paid: Money }
    const mergedDays = new Map<string, DayTotals>();
    r.rows.forEach((x, i) => {
      const cur = mergedDays.get(String(x.day)) ?? { date: parseISO(String(x.day)), spend: ZERO_MONEY, paid: ZERO_MONEY };
      cur.spend = addMoney(cur.spend, translatedSpend[i]!);
      cur.paid = addMoney(cur.paid, translatedPaid[i]!);
      mergedDays.set(String(x.day), cur);
    });
    const days: DayTotals[] = [...mergedDays.values()];
    const grandTotalSpend = sumMoney(days.map((d) => d.spend));

    // Monthly payment rollups with the largest payment's day of month.
    const monthly = new Map<string, { total: Money; count: number; largestDay: number | null; largestAmt: Money }>();
    for (const d of days) {
      if (compareMoney(d.paid, ZERO_MONEY) <= 0) continue;
      const mKey = toISO(d.date).slice(0, 7);
      const m = monthly.get(mKey) ?? { total: ZERO_MONEY, count: 0, largestDay: null, largestAmt: ZERO_MONEY };
      m.total = addMoney(m.total, d.paid);
      m.count += 1;
      if (compareMoney(d.paid, m.largestAmt) > 0) { m.largestAmt = d.paid; m.largestDay = d.date.getUTCDate(); }
      monthly.set(mKey, m);
    }
    const monthlyTotals = [...monthly.entries()]
      .map(([month, m]) => ({ month, total: m.total, paymentCount: m.count, largestPaymentDay: m.largestDay }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const currentMonth = asOfIso.slice(0, 7);
    const dayOfMonth = asOf.getUTCDate();
    const completedMonths = monthlyTotals.filter((m) =>
      m.month < currentMonth || (m.month === currentMonth && compareMoney(m.total, ZERO_MONEY) > 0 && m.largestPaymentDay !== null && dayOfMonth >= m.largestPaymentDay));

    let medianPayment: Money = ZERO_MONEY;
    let avgPayment: Money = ZERO_MONEY;
    let paymentTrend: Money = ZERO_MONEY;
    if (completedMonths.length > 0) {
      const amounts = completedMonths.map((m) => m.total);
      const sorted = [...amounts].sort(compareMoney);
      const mid = Math.floor(sorted.length / 2);
      medianPayment = sorted.length % 2 !== 0 ? sorted[mid]! : divideMoney(addMoney(sorted[mid - 1]!, sorted[mid]!), "2");
      avgPayment = divideMoney(sumMoney(amounts), String(amounts.length));
      if (completedMonths.length >= 4) {
        const recent = completedMonths.slice(-3);
        const older = completedMonths.slice(0, -3);
        const recentAvg = divideMoney(sumMoney(recent.map((m) => m.total)), String(recent.length));
        const olderAvg = divideMoney(sumMoney(older.map((m) => m.total)), String(older.length));
        paymentTrend = compareMoney(olderAvg, ZERO_MONEY) > 0
          ? divideMoney(subtractMoney(recentAvg, olderAvg), olderAvg)
          : ZERO_MONEY;
      }
    } else {
      // No completed payment month: the window's daily rate scaled to the
      // forecast month's exact length.
      const monthlySpendRate = multiplyMoney(divideMoney(grandTotalSpend, String(lookbackDays)), String(daysInMonthUTC(asOf)));
      medianPayment = monthlySpendRate;
      avgPayment = monthlySpendRate;
    }

    // Primary payment day (mode; median when all unique).
    const primaryDays = completedMonths.filter((m) => m.largestPaymentDay !== null).map((m) => m.largestPaymentDay!);
    let detectedPaymentDay = model.cardDefaultPayDay;
    if (primaryDays.length > 0) {
      const counts = new Map<number, number>();
      for (const d of primaryDays) counts.set(d, (counts.get(d) ?? 0) + 1);
      let maxCount = 0;
      for (const [day, count] of counts) if (count > maxCount) { maxCount = count; detectedPaymentDay = day; }
      if (maxCount === 1 && primaryDays.length > 1) {
        const sortedDays = [...primaryDays].sort((a, b) => a - b);
        detectedPaymentDay = sortedDays[Math.floor(sortedDays.length / 2)]!;
      }
    }

    const dailyBurnRate = divideMoney(grandTotalSpend, String(lookbackDays));
    // A card without history and without a configured threshold has no cycle
    // to forecast from: refuse by name instead of falling back to a
    // currency-blind 10000 that silently reports "30 days since last payment".
    const configuredThreshold = cat.significantPaymentThreshold;
    let effectiveThreshold: Money;
    if (configuredThreshold !== undefined && compareMoney(configuredThreshold, ZERO_MONEY) > 0) {
      effectiveThreshold = normalizeMoneyValue(configuredThreshold);
    } else if (compareMoney(medianPayment, ZERO_MONEY) > 0) {
      effectiveThreshold = multiplyMoney(medianPayment, "0.5");
    } else {
      throw new CategoryForecastRefusal(cat.id, cat.name);
    }
    const significantPayments = days.filter((d) => compareMoney(d.paid, effectiveThreshold) > 0).sort((a, b) => b.date.getTime() - a.date.getTime());
    const lastPaymentDate = significantPayments[0]?.date ?? null;
    const daysSinceLastPayment = lastPaymentDate ? Math.ceil((asOf.getTime() - lastPaymentDate.getTime()) / MS_DAY) : model.cardStalePaymentDays;

    let nextPaymentDate = new Date(asOf);
    nextPaymentDate.setUTCDate(Math.min(detectedPaymentDay, daysInMonthUTC(nextPaymentDate)));
    if (nextPaymentDate <= asOf) {
      nextPaymentDate = addMonthsUTC(nextPaymentDate, 1);
      nextPaymentDate.setUTCDate(Math.min(detectedPaymentDay, daysInMonthUTC(nextPaymentDate)));
    }
    nextPaymentDate = businessDay(nextPaymentDate);

    // Projected growth to statement close, then trajectory/median blend.
    const daysFromPaymentToStatementClose = model.cardStatementCloseDays;
    const cycleProgress = compareMoney(medianPayment, ZERO_MONEY) > 0
      ? compareMoney(totalCurrentBalance, medianPayment) >= 0
        ? "1.0000"
        : divideMoney(totalCurrentBalance, medianPayment)
      : "1.0000";
    const daysRemainingToAccrue = compareMoney(cycleProgress, "1.0000") >= 0
      ? ZERO_MONEY
      : multiplyMoney(String(daysFromPaymentToStatementClose), subtractMoney("1.0000", cycleProgress));
    const trajectoryEstimate = addMoney(totalCurrentBalance, multiplyMoney(dailyBurnRate, daysRemainingToAccrue));
    const varianceFromMedian = compareMoney(medianPayment, ZERO_MONEY) > 0
      ? divideMoney(absMoney(subtractMoney(trajectoryEstimate, medianPayment)), medianPayment)
      : ZERO_MONEY;
    let projectedPayment: Money;
    let projectionMethod: string;
    if (compareMoney(varianceFromMedian, normalizeMoneyValue(String(model.cardTrajectoryTolerance))) <= 0) {
      projectedPayment = trajectoryEstimate;
      projectionMethod = "Current Cycle Trajectory";
    } else if (compareMoney(trajectoryEstimate, medianPayment) < 0) {
      projectedPayment = medianPayment;
      projectionMethod = "Historical Median (Low Trajectory)";
    } else {
      projectedPayment = blendTrajectoryPayment(medianPayment, trajectoryEstimate, model.cardMedianBlendWeight);
      projectionMethod = "Blended (High Trajectory)";
    }

    breakdown = completedMonths.map((m) => ({
      name: monthYearLabel(new Date(m.month + "-01T00:00:00Z"), locale, "numeric"),
      amount: m.total,
      type: "Historical",
      details: `${m.paymentCount} payment(s), Day ${m.largestPaymentDay}`,
    }));
    let paymentDate = new Date(nextPaymentDate);
    let isFirstPayment = true;
    while (paymentDate <= tEnd) {
      const wk = toISO(weekStart(paymentDate));
      const amountToPay = isFirstPayment ? projectedPayment : medianPayment;
      const weekIndex = wkIndex.get(wk);
      if (weekIndex !== undefined) weeklyExact[weekIndex] = addMoney(weeklyExact[weekIndex] ?? ZERO_MONEY, amountToPay);
      if (isFirstPayment) {
        breakdown.unshift({ name: "Next Payment", amount: amountToPay, date: toISO(paymentDate), type: "Projection", details: projectionMethod });
        isFirstPayment = false;
      }
      paymentDate = addMonthsUTC(paymentDate, 1);
      paymentDate.setUTCDate(Math.min(detectedPaymentDay, daysInMonthUTC(paymentDate)));
      paymentDate = businessDay(paymentDate);
    }
    breakdown.push({ name: "Current Balance", amount: totalCurrentBalance, type: "Info", details: `${daysSinceLastPayment} days since last payment` });

    logic = `card cycle · pays day ${detectedPaymentDay} · median ${money(medianPayment, { maximumFractionDigits: 0 })}`;
    meta = {
      method: "Credit Card Cycle",
      detectedPaymentDay,
      medianPayment,
      avgPayment,
      currentBalance: totalCurrentBalance,
      daysSinceLastPayment,
      dailyBurnRate,
      monthlySpendRate: multiplyMoney(dailyBurnRate, String(daysInMonthUTC(asOf))),
      paymentTrend: `${multiplyMoney(paymentTrend, "100")}%`,
      monthsAnalyzed: completedMonths.length,
      accountsIncluded: accountIds.length,
      nextPaymentDate: toISO(nextPaymentDate),
      projectedGrowth: subtractMoney(projectedPayment, totalCurrentBalance),
    };
  } else if (cat.method === "formula_expression" && cat.formula) {
    let expression = cat.formula.toUpperCase();
    expression = expression
      .replace(/IF\s*\(([^,]+),([^,]+),([^)]+)\)/g, "($1 ? $2 : $3)")
      .replace(/MAX\(/g, "max(").replace(/MIN\(/g, "min(").replace(/ABS\(/g, "abs(")
      .replace(/CEIL\(/g, "ceil(").replace(/FLOOR\(/g, "floor(").replace(/ROUND\(/g, "round(")
      .replace(/SQRT\(/g, "sqrt(").replace(/POW\(/g, "pow(").replace(/AVG\(/g, "avg(");
    // The rate is effective-dated per week being forecast — one read per
    // week, only for formulas that price tax.
    const weekTaxRates = expression.includes("{TAX_RATE}")
      ? await Promise.all(weekStarts.map((k) => resolveFormulaTaxRateForCategory(orgId, cat, k)))
      : [];
    weekStarts.forEach((k, i) => {
      const cur = parseISO(k);
      const weekIndex = i + 1;
      const valAR = context.arWeekly[k] ?? ZERO_MONEY;
      const valAP = context.apWeekly[k] ?? ZERO_MONEY;
      const monthNum = cur.getUTCMonth() + 1;
      const dayOfMonth = cur.getUTCDate();
      const weekEnd = addDays(cur, 6);
      const isMonthStart = dayOfMonth <= 7 ? 1 : 0;
      const isMonthEnd = weekEnd.getUTCMonth() !== cur.getUTCMonth() || dayOfMonth >= 25 ? 1 : 0;
      // Quarter flags resolve on the FISCAL calendar, never calendar
      // quarters: the offset counts months from the org's fiscal year start.
      const fiscal = fiscalFormulaFlags(k, context.fiscalStartMonth ?? 1, isMonthStart, isMonthEnd);
      const evalStr = expression
        .replace(/{AR_IN}/g, String(valAR)).replace(/{AP_OUT}/g, String(valAP))
        .replace(/{NET_FLOW}/g, subtractMoney(valAR, valAP)).replace(/{CASH_START}/g, String(context.cashStart))
        .replace(/{WEEK_NUM}/g, String(weekIndex)).replace(/{MONTH}/g, String(monthNum))
        .replace(/{QUARTER}/g, String(fiscal.quarter)).replace(/{YEAR}/g, String(cur.getUTCFullYear()))
        .replace(/{DAY}/g, String(dayOfMonth))
        .replace(/{IS_WK1}/g, weekIndex === 1 ? "1" : "0").replace(/{IS_WK2}/g, weekIndex === 2 ? "1" : "0")
        .replace(/{IS_WK3}/g, weekIndex === 3 ? "1" : "0").replace(/{IS_WK4}/g, weekIndex === 4 ? "1" : "0")
        .replace(/{IS_WK5}/g, weekIndex >= 5 ? "1" : "0")
        .replace(/{IS_MONTH_START}/g, String(isMonthStart)).replace(/{IS_MONTH_END}/g, String(isMonthEnd))
        .replace(/{IS_Q_START}/g, String(fiscal.isQStart))
        .replace(/{IS_Q_END}/g, String(fiscal.isQEnd))
        .replace(/{IS_YEAR_END}/g, String(fiscal.isYearEnd))
        .replace(/{TAX_RATE}/g, weekTaxRates[i] ?? "0").replace(/{TRUE}/g, "1").replace(/{FALSE}/g, "0");
      // A malformed tenant formula is a refusal the operator must see named,
      // never a silent 0 forecast that looks like "no cash expected" —
      // forecast-only, but it is the forecast the release gate reads.
      // evaluateFormula returns an exact numeric(19,4) string (never a
      // float), so no rounding crosses the IEEE-754 boundary here.
      let result: string;
      try {
        result = evaluateFormula(evalStr);
      } catch (e) {
        throw new Error(
          `cash forecast formula "${cat.formula}" failed for the week of ${k}: ${(e as Error).message}`,
        );
      }
      weekly[i] = normalizeMoneyValue(result);
    });
    logic = cat.formula.length > 60 ? `${cat.formula.slice(0, 57)}…` : cat.formula;
    meta = { method: "Calculated Formula", formula: cat.formula };
    breakdown = [{ name: "Computed via Formula", amount: sumMoney(weekly), type: "Formula" }];
  } else if (cat.method === "vendor_recurring_average" && (cat.partyIds?.length || cat.partyId)) {
    const vids = cat.partyIds?.length ? cat.partyIds : [cat.partyId!];
    const historyMonths = Math.max(1, Math.min(36, cat.historyMonths ?? 3));
    const idList = sql.join(vids.map((v) => sql`${v}`), sql`, `);
    const r = (await analyticsQuery<CashPaymentEventRow>(sql`
      -- Same functional-currency translation as the payment history above,
      -- then into presentation currency per (day, functional) leg: daily
      -- totals never add two subsidiaries' functionals raw.
      select coalesce(d.document_date, d.posting_date)::text as day, sub.base_currency as func,
             sum(round(abs(d.total * d.fx_rate), 4)) as paid,
             max(coalesce(d.document_date, d.posting_date))::text as late
      from documents d
      -- Root-owned documents carry no subsidiary: a left join keeps them
      -- (their null functional maps to the org base at translation time)
      -- instead of silently dropping their payments from the history.
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      where d.org_id = ${orgId} and d.party_id in (${idList}) and d.voided_at is null
        and d.kind in ('vendor_payment', 'check')
        and coalesce(d.document_date, d.posting_date) >= ${asOfIso}::date - (${historyMonths} || ' months')::interval${subScope(sql`d.subsidiary_id`, context.subIds, context.includeNullSubsidiary === true)}
      group by 1, 2
    `));
    const translatedEvents = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.late ?? x.day), amount: normalizeMoneyValue(String(x.paid)) })),
    );
    const mergedEvents = new Map<string, Money>();
    r.rows.forEach((x, i) => {
      const day = String(x.day);
      mergedEvents.set(day, addMoney(mergedEvents.get(day) ?? ZERO_MONEY, translatedEvents[i]!));
    });
    const events = [...mergedEvents.entries()]
      .map(([day, amount]) => ({ date: parseISO(day), amount }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    if (events.length >= 2) {
      const intervals: number[] = [];
      for (let i = 0; i < events.length - 1; i++) {
        intervals.push(Math.ceil(Math.abs(events[i]!.date.getTime() - events[i + 1]!.date.getTime()) / MS_DAY));
      }
      intervals.sort((a, b) => a - b);
      const medianInterval = intervals[Math.floor(intervals.length / 2)]!;
      let frequencyLabel = "Monthly";
      let nextIntervalDays = 30;
      if (medianInterval >= 5 && medianInterval <= 9) { frequencyLabel = "Weekly"; nextIntervalDays = 7; }
      else if (medianInterval >= 12 && medianInterval <= 16) { frequencyLabel = "Bi-Weekly"; nextIntervalDays = 14; }
      const amounts = events.map((e) => e.amount);
      const filtered = filterRecurringOutliers(amounts, model.vendorOutlierSigma);
      let avgAmount = divideMoney(sumMoney(filtered), String(filtered.length));
      if (adj !== 0) avgAmount = multiplyMoney(avgAmount, String(1 + adj));
      let nextDate = addDays(events[0]!.date, nextIntervalDays);
      while (nextDate < asOf) nextDate = addDays(nextDate, nextIntervalDays);
      while (nextDate <= tEnd) {
        const weekIndex = wkIndex.get(toISO(weekStart(nextDate)));
        if (weekIndex !== undefined) weeklyExact[weekIndex] = addMoney(weeklyExact[weekIndex] ?? ZERO_MONEY, avgAmount);
        nextDate = addDays(nextDate, nextIntervalDays);
      }
      logic = `${frequencyLabel.toLowerCase()} cadence auto-detected · avg ${money(avgAmount, { maximumFractionDigits: 0 })}`;
      meta = {
        method: "Vendor Recurring (Auto)",
        frequency: frequencyLabel,
        avgAmount,
        samples: events.length,
        interval: medianInterval,
        vendors: vids.length,
      };
    } else {
      logic = "not enough payment history to detect a cadence";
      meta = { method: "Vendor Recurring (Auto)", samples: events.length };
    }
    breakdown = events.map((e) => ({ name: "Historical Payment", amount: e.amount, date: toISO(e.date), type: "Source Data" }));
  } else if (cat.method === "bank_register_history" && cat.bankAccountIds?.length) {
    const historyWeeks = Math.max(1, Math.min(52, cat.historyWeeks ?? 12));
    const historyStart = addDays(tStart, -historyWeeks * 7);
    const ids = sql.join(cat.bankAccountIds.map((a) => sql`${a}`), sql`, `);
    const includeTransfers = cat.includeTransfers !== false;
    const includeChecks = cat.includeChecks !== false;
    const includeJournals = cat.includeJournals === true;
    const kindClauses = [];
    if (includeTransfers) kindClauses.push(sql`d.kind = 'transfer'`);
    if (includeChecks) kindClauses.push(sql`d.kind in ('vendor_payment', 'check')`);
    if (includeJournals) kindClauses.push(sql`d.id is null`);
    if (kindClauses.length === 0) kindClauses.push(sql`false`);
    const kindFilter = sql.join(kindClauses, sql` or `);
    const keywords = (cat.memoKeywords ?? []).map((k) => k.trim()).filter(Boolean);
    const memoFilter = keywords.length
      ? sql` and (${sql.join(keywords.map((k) => sql`coalesce(d.memo, e.memo, '') ilike ${"%" + k + "%"}`), sql` or `)})`
      : sql``;
    const r = (await analyticsQuery<CashRegisterLineRow>(sql`
      -- One row per in-scope bank leg with its functional currency. Transfers
      -- net PER ENTRY over the in-scope bank legs (see the merge below): a
      -- plain move between two selected banks nets to zero, a fee-bearing one
      -- (bank A -100, bank B +95, fee expense +5) counts only the negative
      -- remainder (-100 + 95 = -5, so 5 of outflow), and a transfer to an
      -- out-of-scope account keeps its full leg — cash really left the viewed
      -- set. Translating legs BEFORE netting keeps multi-subsidiary transfers
      -- honest; a single-functional entry nets exactly as before.
      select e.posting_date::text as day, coalesce(d.kind, 'journal') as kind,
             d.document_number as doc_number, coalesce(p.display_name, '') as party,
             coalesce(d.memo, e.memo, '') as memo,
             l.entry_id::text as entry_id, l.amount as raw_amount, sub.base_currency as func
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
        and e.book_id = ${statementBookExpr(orgId)}
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      join subsidiaries sub on sub.id = l.subsidiary_id
      where l.org_id = ${orgId} and l.account_id in (${ids})
        and (l.amount < 0 or coalesce(d.kind, 'journal') = 'transfer')
        and e.posting_date >= ${toISO(historyStart)} and e.posting_date <= ${asOfIso}
        and (${kindFilter})${memoFilter}${subScope(sql`l.subsidiary_id`, context.subIds)}
    `));
    const translatedLegs = await translateHistoryLegs(
      orgId,
      r.rows.map((x) => ({ func: x.func, date: String(x.day), amount: normalizeMoneyValue(String(x.raw_amount)) })),
    );
    // Non-transfer legs contribute their outflow directly; transfer legs net
    // per entry over the translated in-scope legs (inflows included — they
    // are in the rows above precisely so the net sees them).
    interface RegisterContribution { day: string; kind: string; doc_number: string | null; party: string; memo: string; amount: Money }
    const contributions: RegisterContribution[] = [];
    const transferEntries = new Map<string, { day: string; kind: string; doc_number: string | null; party: string; memo: string; outflow: RegisterContribution | null; total: Money }>();
    r.rows.forEach((x, i) => {
      const amount = translatedLegs[i]!;
      if (String(x.kind) !== "transfer") {
        contributions.push({
          day: String(x.day), kind: String(x.kind), doc_number: (x.doc_number as string | null) ?? null,
          party: String(x.party ?? ""), memo: String(x.memo ?? ""), amount: normalizeMoneyValue(String(moneyNeg(amount))),
        });
        return;
      }
      const entryId = String(x.entry_id);
      const cur = transferEntries.get(entryId) ?? {
        day: String(x.day), kind: String(x.kind), doc_number: (x.doc_number as string | null) ?? null,
        party: String(x.party ?? ""), memo: String(x.memo ?? ""), outflow: null, total: ZERO_MONEY,
      };
      cur.total = addMoney(cur.total, amount);
      if (compareMoney(amount, ZERO_MONEY) < 0 && cur.outflow === null) {
        cur.outflow = { day: String(x.day), kind: String(x.kind), doc_number: (x.doc_number as string | null) ?? null, party: String(x.party ?? ""), memo: String(x.memo ?? ""), amount: ZERO_MONEY };
      }
      transferEntries.set(entryId, cur);
    });
    for (const entry of transferEntries.values()) {
      // The entry-level net: a plain in-scope move nets to zero, a
      // fee-bearing one keeps only the negative remainder.
      const net = normalizeMoneyValue(String(moneyNeg(entry.total)));
      if (compareMoney(net, ZERO_MONEY) <= 0) continue;
      const display = entry.outflow ?? entry;
      contributions.push({ day: entry.day, kind: entry.kind, doc_number: entry.doc_number, party: display.party, memo: entry.memo, amount: net });
    }
    // Same data-start rule as the GL path (see historyWindowDivisor),
    // measured in this strategy's own read scope: bank legs matching its
    // kind/memo filters, unbounded in time.
    const windowStartIso = toISO(historyStart);
    const bankStartRow = (await analyticsQuery<{ d: string | null }>(sql`
      select min(e.posting_date)::text as d
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
          and e.book_id = ${statementBookExpr(orgId)}
        left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
       where l.org_id = ${orgId} and l.account_id in (${ids}) and l.amount < 0
         and (${kindFilter})${memoFilter}${subScope(sql`l.subsidiary_id`, context.subIds)}
         and not (
           coalesce(d.kind, 'journal') = 'transfer'
           and exists (
             select 1 from journal_lines l2
              where l2.entry_id = l.entry_id and l2.org_id = l.org_id
                and l2.account_id in (${ids})
                and l2.amount > 0
           )
         )
    `));
    const bankStartIso = bankStartRow.rows[0]?.d ?? null;
    const weeklyHistory: Record<string, Money> = {};
    const currentWeekKey = toISO(weekStart(asOf));
    const startKey = toISO(tStart);
    for (const x of contributions) {
      const amount = x.amount;
      if (compareMoney(amount, ZERO_MONEY) <= 0) continue;
      const wk = toISO(weekStart(parseISO(x.day)));
      weeklyHistory[wk] = addMoney(weeklyHistory[wk] ?? ZERO_MONEY, amount);
      const isCurrentWeek = wk === currentWeekKey;
      if (x.day < startKey || isCurrentWeek) {
        breakdown.push({
          name: `${x.day} ${x.kind} ${x.party}${x.doc_number ? ` (${x.doc_number})` : ""}`.trim(),
          amount,
          date: x.day,
          type: isCurrentWeek ? "This Week (Applied)" : "Bank Register",
          ...(x.memo ? { details: String(x.memo) } : {}),
        });
      }
    }
    let totalHistory = ZERO_MONEY;
    for (const k of Object.keys(weeklyHistory)) {
      if (k < startKey) { totalHistory = addMoney(totalHistory, weeklyHistory[k]!); }
    }
    const divisor = historyWindowDivisor(historyWeeks, windowStartIso, bankStartIso);
    let weeklyAvg = fullWindowWeeklyAverage(totalHistory, historyWeeks, windowStartIso, bankStartIso);
    if (adj !== 0) weeklyAvg = multiplyMoney(weeklyAvg, String(1 + adj));
    weekStarts.forEach((k, i) => {
      const actual = weeklyHistory[k] ?? ZERO_MONEY;
      let amount: Money;
      if (k === currentWeekKey && compareMoney(actual, ZERO_MONEY) > 0) {
        const remainder = subtractMoney(weeklyAvg, actual);
        amount = compareMoney(remainder, ZERO_MONEY) > 0 ? remainder : ZERO_MONEY;
      } else if (compareMoney(actual, ZERO_MONEY) > 0 && k > currentWeekKey) amount = actual;
      else amount = weeklyAvg;
      weeklyExact[i] = multiplyMoney(amount, String(getProrationFactor(parseISO(k), asOf, cat.expectedDay, cat.expectedWeek)));
    });
    logic = `${historyWeeks}-week bank register average${adj ? ` ${adj > 0 ? "+" : ""}${Math.round(adj * 100)}%` : ""}${keywords.length ? ` · memo: ${keywords.join(", ")}` : ""}`;
    meta = {
      method: "Bank Register History",
      bankAccounts: cat.bankAccountIds.length,
      historyWeeks,
      rawAverage: fullWindowWeeklyAverage(totalHistory, historyWeeks, windowStartIso, bankStartIso),
      finalAverage: weeklyAvg,
      weeksUsed: divisor,
      currentWeekApplied: weeklyHistory[currentWeekKey] ?? ZERO_MONEY,
      ...(keywords.length ? { memoKeywords: keywords.join(", ") } : {}),
    };
    breakdown.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }

  const finalWeekly = weekly.map((v, i) => weeklyExact[i] ?? v);
  return {
    id: cat.id,
    name: cat.name,
    direction: cat.direction === "inflow" ? "inflow" : "outflow",
    method: cat.method,
    weekly: finalWeekly,
    total: sumMoney(finalWeekly),
    logic,
    meta,
    breakdown: breakdown.map((row) => ({ ...row, amount: normalizeMoneyValue(String(row.amount)) })),
  };
}

export async function bankBalances(asOf: string, subIds?: string[], explicitOrgId?: string) {
  if (subIds?.length === 0) return [];
  // Inception-to-date cash per bank account: whole months from the
  // gl_month_activity summary, the as-of month from the lines. Summing every
  // bank line ever posted cost seconds once a tenant had a real ledger.
  //
  // The org predicates are explicit and the movement legs are restricted to
  // bank accounts: RLS alone scopes rows correctly but its current_setting()
  // comparison is not sargable, so an unqualified leg degrades to a full scan
  // of every journal line in the table.
  //
  // Prefer the explicit org id (the dashboard tile threads its caller's org):
  // ambient request/session resolution is absent in non-request callers, and
  // an unscoped call there fails instead of reading the caller's tenant.
  const orgId = await resolveOrgId(explicitOrgId);
  const r = (await analyticsQuery(sql`
    with bank_accounts as (
      select id from accounts
       where org_id = ${orgId} and type = 'asset_bank' and is_summary = false and is_active
    ),
    -- The as-of month's entries materialize first. Left to itself the planner
    -- reached the sliver through (org, account), which walks every bank line
    -- ever posted before the date filter applies.
    sliver_entries as materialized (
      select id from journal_entries
       where org_id = ${orgId} and status in ('posted', 'reversed')
         and book_id = ${statementBookExpr(orgId)}
         and posting_date >= date_trunc('month', ${asOf}::date)::date
         and posting_date <= ${asOf}
    ),
    movement as (
      -- Legs are stamped in their line entity's functional currency on BOTH
      -- branches (the summary keeps subsidiary id), so each leg carries its
      -- functional out for presentation translation below.
      select g.account_id, (g.debit_total - g.credit_total) as amt, sub.base_currency as func
        from gl_month_activity g
        left join subsidiaries sub on sub.id = g.subsidiary_id and sub.org_id = ${orgId}
       where g.org_id = ${orgId}
         and g.book_id = ${statementBookExpr(orgId)}
         and g.account_id in (select id from bank_accounts)
         and g.month < date_trunc('month', ${asOf}::date)::date
         ${subScope(sql`g.subsidiary_id`, subIds)}
      union all
      select l.account_id, l.amount, sub.base_currency as func
        from sliver_entries se
        join journal_lines l on l.entry_id = se.id and l.org_id = ${orgId}
        left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
       where l.account_id in (select id from bank_accounts)
         ${subScope(sql`l.subsidiary_id`, subIds)}
    )
    select a.id, a.name, a.number, m.func, coalesce(sum(m.amt), 0) as balance
    from accounts a
    left join movement m on m.account_id = a.id
    where a.org_id = ${orgId} and a.type = 'asset_bank' and a.is_summary = false and a.is_active
      ${subIds && subIds.length > 0 ? sql`and (a.subsidiary_id is null or a.subsidiary_id = any(${`{${subIds.join(",")}}`}::uuid[]))` : sql``}
    group by a.id, a.name, a.number, m.func
  `));
  // A consolidated view spans functionals: translate each (account,
  // functional) leg at the closing spot and re-sum per account. Missing rate
  // coverage fails closed — never a mixed-functional total.
  const base = await presentationCurrency(orgId);
  const legs = r.rows as { id: string; name: string; number: string | null; func: string | null; balance: string }[];
  const rates = await presentationRates(orgId, base, legs.map((x) => x.func ?? null), asOf);
  const byAccount = new Map<string, { id: string; name: string; number: string | null; legs: string[] }>();
  for (const x of legs) {
    const cur = byAccount.get(String(x.id)) ?? { id: String(x.id), name: String(x.name), number: x.number == null ? null : String(x.number), legs: [] };
    cur.legs.push(multiplyMoney(String(x.balance), rates.get(lineFunctional(x.func ?? null, base))!));
    byAccount.set(String(x.id), cur);
  }
  return [...byAccount.values()]
    .map((a) => ({ id: a.id, name: a.name, number: a.number, balance: normalizeMoneyValue(sumMoney(a.legs)) }))
    .sort((x, y) => compareMoney(y.balance, x.balance));
}

const CASH_AGING_BUCKETS = ["Current", "1-30", "31-60", "61-90", "90+"] as const;

export function bucketOf(daysPastDue: number): string {
  return CASH_AGING_BUCKETS[agingBucketIndex(daysPastDue)];
}

/** Days past the shared aging basis date: due date, else posting date. */
function daysPastDue(it: OpenItem, asOf: Date): number {
  return daysBetween(agingBasisDate({ dueDate: it.dueDate, postingDate: it.tranDate })!, asOf);
}

/**
 * Predict collection/payment date for one open item. A party with history
 * forecasts from its own average (+ the configured sigma buffer); a party
 * without history falls back to the global average; with neither, the item
 * forecasts at its due date — the contractual date, a fact. An item with
 * neither history nor a due date cannot be placed: null, so the caller
 * counts it instead of inventing a date for it.
 */
export function predict(
  item: OpenItem,
  asOf: Date,
  stats: PaymentStats,
  model: ForecastModelParams = CASHFLOW_MODEL_DEFAULTS,
): { date: Date; method: string } | null {
  let date: Date | null = null;
  let method = "Global avg";
  const s = item.partyId ? stats.map.get(item.partyId) : undefined;
  if (s) {
    const buffer = s.sd ? Math.ceil(s.sd * model.settleBufferSigma) : 0;
    date = addDays(item.tranDate, Math.round(s.avg) + buffer);
    method = "Statistical";
  } else if (stats.globalAvg !== null) {
    date = addDays(item.tranDate, stats.globalAvg);
  } else if (item.dueDate) {
    date = new Date(item.dueDate);
    method = "Due date";
  } else {
    return null;
  }
  // Floor at due date.
  if (item.dueDate && date < item.dueDate) {
    date = new Date(item.dueDate);
    method = "Due date";
  }
  // Overdue → push forward (the configured push ladder).
  if (date < asOf) {
    const overdue = daysBetween(date, asOf);
    const push = overdue > model.overdueLongThresholdDays
      ? model.overduePushLongDays
      : overdue > model.overdueMidThresholdDays
        ? model.overduePushMidDays
        : model.overduePushShortDays;
    date = addDays(asOf, push);
    method = "Overdue push";
  }
  return { date: businessDay(date), method };
}

export function summariseSide(
  items: OpenItem[],
  asOf: Date,
  scheduled: Money,
  avgDays: number | null,
  unplaced: { count: number; total: Money } = { count: 0, total: ZERO_MONEY },
): SideSummary {
  const buckets = new Map<string, Money>([
    ["Current", ZERO_MONEY], ["1-30", ZERO_MONEY], ["31-60", ZERO_MONEY], ["61-90", ZERO_MONEY], ["90+", ZERO_MONEY],
  ]);
  let outstanding = ZERO_MONEY;
  for (const it of items) {
    outstanding = addMoney(outstanding, it.remaining);
    const dpd = daysPastDue(it, asOf);
    const b = bucketOf(dpd);
    buckets.set(b, addMoney(buckets.get(b) ?? ZERO_MONEY, it.remaining));
  }
  const current = buckets.get("Current") ?? ZERO_MONEY;
  return {
    outstanding,
    scheduled,
    pctCurrent: compareMoney(outstanding, ZERO_MONEY) > 0 ? divideMoney(current, outstanding) : ZERO_MONEY,
    avgDays,
    buckets: [...buckets.entries()].map(([label, amount], index) => ({ label, amount, index })),
    unplaced,
  };
}

/**
 * Predict every open item into a week bucket ( /
 * buildAPForecast). Returns the by-week entry map and the total scheduled
 * inside the horizon — the shared step behind the analytics timeline and the
 * cockpit worklists.
 */
export function scheduleForecast(
  items: OpenItem[],
  stats: PaymentStats,
  asOf: Date,
  start: Date,
  end: Date,
  model: ForecastModelParams = CASHFLOW_MODEL_DEFAULTS,
): {
    byWeek: Map<string, ForecastEntry[]>;
    entries: ForecastEntry[];
    scheduled: Money;
    /** Items placed in no week (no history and no due date), counted, never dropped. */
    unplaced: { count: number; total: Money };
  } {
  const byWeek = new Map<string, ForecastEntry[]>();
  const entries: ForecastEntry[] = [];
  let scheduled = ZERO_MONEY;
  let unplacedCount = 0;
  let unplacedTotal = ZERO_MONEY;
  for (const it of items) {
    const predicted = predict(it, asOf, stats, model);
    if (!predicted) {
      unplacedCount += 1;
      unplacedTotal = addMoney(unplacedTotal, it.remaining);
      continue;
    }
    const { date, method } = predicted;
    if (date < start || date > end) continue;
    const wk = toISO(weekStart(date));
    const dpd = daysPastDue(it, asOf);
    const entry: ForecastEntry = {
      id: it.id,
      entryId: it.entryId,
      docKind: it.docKind,
      docNumber: it.docNumber,
      docId: it.docId,
      partyId: it.partyId,
      partyName: it.partyName,
      amount: it.remaining,
      tranDate: toISO(it.tranDate),
      dueDate: it.dueDate ? toISO(it.dueDate) : null,
      predictedDate: toISO(date),
      weekStart: wk,
      daysOverdue: Math.max(0, dpd),
      method,
    };
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk)!.push(entry);
    entries.push(entry);
    scheduled = addMoney(scheduled, it.remaining);
  }
  return { byWeek, entries, scheduled, unplaced: { count: unplacedCount, total: unplacedTotal } };
}
