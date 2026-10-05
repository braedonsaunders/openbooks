import {
  add,
  cmp,
  div,
  mul,
  neg,
  roundDiv,
  sum,
} from "../money/money.ts";
import { addCalendarDays } from "../platform/civil-date.ts";

/**
 * Statistical demand forecasting on weekly base-unit quantities.
 *
 * Every value in this module is an exact decimal string (ledger 4dp): the
 * smoothing updates multiply and divide through the money kernel, so a
 * forecast never accumulates binary floating-point error and a re-run over
 * the same history produces the same stored values bit for bit. Stored
 * quantities stay at four decimal places — the finest precision stock is
 * kept at — and lot-size rounding (case packs, minimum order quantities)
 * happens later, on the suggestion, never inside the model.
 *
 * Regimes, in order:
 * - intermittent demand (many zero weeks) forecasts with Croston/SBA;
 * - seasonal demand forecasts with Holt-Winters additive or multiplicative,
 *   chosen by holdout error;
 * - short or flat history falls back to a moving average.
 * Model selection is always by holdout mean absolute error unless the caller
 * pins a method. Promotion windows enter as data (see PromotionWindow): the
 * lift is measured from history, history is de-promoted before fitting, and
 * future promotion weeks are uplifted again.
 */

export interface DemandWeek {
  /** ISO Monday of the demand week, matching Postgres date_trunc('week'). */
  weekStart: string;
  /** Issued base-unit quantity that week, exact decimal. */
  quantity: string;
  /** True when the shelf was empty, so a zero here censors demand. */
  stockout: boolean;
}

/** A promotion active over an inclusive civil-date window. */
export interface PromotionWindow {
  code: string;
  startsOn: string;
  endsOn: string;
}

export type ForecastMethod =
  | "seasonal_additive"
  | "seasonal_multiplicative"
  | "croston_sba"
  | "moving_average";

export type ForecastMethodPreference = "auto" | "seasonal" | "intermittent" | "average";

export interface ForecastOptions {
  horizonWeeks: number;
  method?: ForecastMethodPreference;
  /** 80% interval z by default; the caller passes its service z for parity. */
  bandZ?: string;
  promotionWindows?: readonly PromotionWindow[];
  /** Planned promotion weeks inside the horizon to uplift, as ISO Mondays. */
  plannedPromotionWeeks?: readonly string[];
}

export interface ForecastPeriod {
  periodStart: string;
  quantity: string;
  lower: string;
  upper: string;
  method: ForecastMethod;
}

export interface ForecastExplanation {
  method: ForecastMethod;
  historyWeeks: number;
  holdoutWeeks: number;
  holdoutMaeByMethod: Record<string, string>;
  stockoutWeeksImputed: string[];
  /** Classical decomposition only: 1-based peak month of the seasonal index. */
  seasonalPeakMonth: number | null;
  seasonalPeriodWeeks: number | null;
  promotionCode: string | null;
  /** Exact lift factor, e.g. "1.3000" for a 30% lift. */
  promotionLiftFactor: string | null;
  promotionIgnoredReason: string | null;
  /** Residual standard deviation of the fitted model, exact decimal. */
  residualSigma: string;
}

export interface ForecastResult {
  periods: ForecastPeriod[];
  explanation: ForecastExplanation;
}

const ZERO = "0.0000";
const ONE = "1.0000";
const sub = (a: string, b: string): string => add(a, neg(b));
const mean = (values: readonly string[]): string =>
  values.length === 0 ? ZERO : div(sum([...values]), String(values.length));

/** Mean absolute error of predictions against actuals, exact decimal. */
function mae(actual: readonly string[], predicted: readonly string[]): string {
  if (actual.length === 0) return ZERO;
  const errors = actual.map((value, index) => {
    const diff = sub(value, predicted[index]!);
    return cmp(diff, ZERO) < 0 ? neg(diff) : diff;
  });
  return mean(errors);
}

/**
 * Integer square root rounded halves away from zero, by Newton's method on
 * bigints. Residual variances live as scaled integers, so the standard
 * deviation needs no float: sqrt(v * 1e4) is sigma in ledger units, and a
 * remainder past the halfway point rounds the last unit up.
 */
export function roundedSqrtUnits(scaled: bigint): bigint {
  if (scaled < 0n) throw new Error("cannot take the square root of a negative variance");
  if (scaled === 0n) return 0n;
  let root = scaled;
  let next = (scaled + 1n) / 2n;
  while (next < root) {
    root = next;
    next = (root + scaled / root) / 2n;
  }
  const remainder = scaled - root * root;
  return remainder > root ? root + 1n : root;
}

const SCALE = 10_000n;

/** Population standard deviation of exact decimals, rounded to 4dp. */
export function decimalStd(values: readonly string[]): string {
  if (values.length === 0) return ZERO;
  const center = mean(values);
  const squared = values.map((value) => mul(sub(value, center), sub(value, center)));
  const varianceUnits = (() => {
    // mul() returns canonical ledger strings with exactly four decimals, so
    // stripping the point yields integer ledger units; roundDiv rounds the
    // mean half away from zero instead of flooring it down.
    const total = squared.reduce((acc, value) => acc + BigInt(value.replace(".", "")), 0n);
    return roundDiv(total, BigInt(values.length));
  })();
  const scaled = varianceUnits * SCALE;
  const root = roundedSqrtUnits(scaled < 0n ? 0n : scaled);
  const whole = root / SCALE;
  const fraction = (root % SCALE).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

/**
 * Stockout weeks carry no demand signal: a zero there means "could not sell",
 * not "nobody wanted". Replace each with the mean of its nearest
 * non-stockout neighbours (searching outward symmetrically keeps a trend
 * from dragging the fill). A series with no clean week has no signal and
 * forecasts zero with that fact in the explanation.
 */
export function imputeStockouts(weeks: readonly DemandWeek[]): { corrected: string[]; imputed: string[] } {
  const corrected = weeks.map((week) => week.quantity);
  const imputed: string[] = [];
  const clean = (index: number): boolean => !weeks[index]!.stockout;
  for (let index = 0; index < weeks.length; index++) {
    if (!weeks[index]!.stockout) continue;
    const neighbours: string[] = [];
    for (let distance = 1; distance < weeks.length; distance++) {
      const before = index - distance;
      const after = index + distance;
      if (before >= 0 && clean(before)) neighbours.push(corrected[before]!);
      if (after < weeks.length && clean(after)) neighbours.push(corrected[after]!);
      if (neighbours.length >= 2) break;
    }
    if (neighbours.length === 0) {
      corrected[index] = ZERO;
    } else {
      corrected[index] = mean(neighbours);
    }
    imputed.push(weeks[index]!.weekStart);
  }
  return { corrected, imputed };
}

/** Average inter-demand interval: mean weeks between nonzero weeks. */
export function averageDemandInterval(quantities: readonly string[]): string {
  const gaps: number[] = [];
  let since = 0;
  let seen = 0;
  for (const quantity of quantities) {
    since += 1;
    if (cmp(quantity, ZERO) !== 0) {
      if (seen > 0) gaps.push(since);
      seen += 1;
      since = 0;
    }
  }
  if (quantities.length === 0) return ZERO;
  // Demand every week has an interval of one, not of the series length: only
  // a single lonely sale (or none at all) stretches the interval out.
  if (gaps.length === 0) return seen <= 1 ? String(quantities.length) : ONE;
  return div(String(gaps.reduce((a, b) => a + b, 0)), String(gaps.length));
}

function zeroShare(quantities: readonly string[]): number {
  if (quantities.length === 0) return 1;
  return quantities.filter((quantity) => cmp(quantity, ZERO) === 0).length / quantities.length;
}

/** Weeks of `series` overlapped by any promotion window. */
export function promotionWeeksOf(
  weekStarts: readonly string[],
  windows: readonly PromotionWindow[],
): Set<string> {
  const overlapped = new Set<string>();
  for (const weekStart of weekStarts) {
    const weekEnd = addCalendarDays(weekStart, 6);
    for (const window of windows) {
      if (weekStart <= window.endsOn && weekEnd >= window.startsOn) {
        overlapped.add(weekStart);
        break;
      }
    }
  }
  return overlapped;
}

/**
 * Measured promotion lift: mean demand over promoted weeks divided by mean
 * demand over unpromoted weeks. Null when either side is too thin to trust
 * (fewer than two weeks) or the baseline is zero — the caller then ignores
 * promotions and says so, rather than pricing a guess.
 */
export function measurePromotionLift(
  weekStarts: readonly string[],
  quantities: readonly string[],
  windows: readonly PromotionWindow[],
): { code: string | null; factor: string | null; ignoredReason: string | null } {
  if (windows.length === 0) return { code: null, factor: null, ignoredReason: null };
  const overlapped = promotionWeeksOf(weekStarts, windows);
  const promo = quantities.filter((_, index) => overlapped.has(weekStarts[index]!));
  const base = quantities.filter((_, index) => !overlapped.has(weekStarts[index]!));
  if (promo.length < 2 || base.length < 2) {
    return { code: null, factor: null, ignoredReason: "fewer than two promoted or unpromoted weeks" };
  }
  const baseMean = mean(base);
  if (cmp(baseMean, ZERO) <= 0) {
    return { code: null, factor: null, ignoredReason: "no baseline demand outside promotions" };
  }
  const codes = [...new Set(windows.map((window) => window.code))].sort().join(",");
  return { code: codes, factor: div(mean(promo), baseMean), ignoredReason: null };
}

const ALPHA = "0.3";
const BETA = "0.1";
const GAMMA = "0.3";
const CROSTON_ALPHA = "0.2";

interface Fit {
  method: ForecastMethod;
  fitted: string[];
  forecast: (steps: number) => string[];
}

/** Flat forecast at the mean of the last thirteen (or fewer) weeks. */
function fitMovingAverage(train: readonly string[]): Fit {
  const window = train.slice(-Math.min(13, train.length));
  const level = mean(window.length === 0 ? [ZERO] : window);
  return {
    method: "moving_average",
    fitted: train.map(() => level),
    forecast: (steps: number) => Array.from({ length: steps }, () => level),
  };
}

/**
 * Holt-Winters with classical-decomposition starts, in exact decimals.
 * Multiplicative refuses zero training weeks (a zero demand week makes a
 * ratio index meaningless) by returning null, so selection falls through.
 */
function fitSeasonal(
  train: readonly string[],
  seasonLength: number,
  multiplicative: boolean,
): Fit | null {
  if (train.length < seasonLength * 2) return null;
  if (multiplicative && train.some((quantity) => cmp(quantity, ZERO) <= 0)) return null;
  const first = train.slice(0, seasonLength);
  const second = train.slice(seasonLength, seasonLength * 2);
  const level0 = mean(first);
  const trend0 = div(sub(mean(second), level0), String(seasonLength));
  const seasonal = first.map((quantity) =>
    multiplicative
      ? cmp(level0, ZERO) > 0 ? div(quantity, level0) : ONE
      : sub(quantity, level0),
  );
  let level = level0;
  let trend = trend0;
  const season = [...seasonal];
  const fitted: string[] = [];
  for (let position = 0; position < train.length; position++) {
    const seasonalIndex = position % seasonLength;
    const previous = season[seasonalIndex]!;
    const deseasonalized = multiplicative
      ? cmp(previous, ZERO) > 0 ? div(train[position]!, previous) : train[position]!
      : sub(train[position]!, previous);
    const nextLevel = add(mul(ALPHA, deseasonalized), mul(sub(ONE, ALPHA), add(level, trend)));
    const nextTrend = add(mul(BETA, sub(nextLevel, level)), mul(sub(ONE, BETA), trend));
    const nextSeasonal = multiplicative
      ? cmp(nextLevel, ZERO) > 0
        ? add(mul(GAMMA, div(train[position]!, nextLevel)), mul(sub(ONE, GAMMA), previous))
        : previous
      : add(mul(GAMMA, sub(train[position]!, nextLevel)), mul(sub(ONE, GAMMA), previous));
    fitted.push(multiplicative ? mul(add(level, trend), previous) : add(add(level, trend), previous));
    level = nextLevel;
    trend = nextTrend;
    season[seasonalIndex] = nextSeasonal;
  }
  return {
    method: multiplicative ? "seasonal_multiplicative" : "seasonal_additive",
    fitted,
    forecast: (steps: number) =>
      Array.from({ length: steps }, (_, step) => {
        const anchor = add(level, mul(trend, String(step + 1)));
        const seasonalIndex = (train.length + step) % seasonLength;
        return multiplicative ? mul(anchor, season[seasonalIndex]!) : add(anchor, season[seasonalIndex]!);
      }),
  };
}

/**
 * Croston with the Syntetos-Boylan Approximation: demand size and demand
 * interval smooth separately, and the (1 − α/2) factor removes Croston's
 * positive bias. Flat by construction — the right answer for demand that
 * arrives in bursts.
 */
function fitCrostonSba(train: readonly string[]): Fit {
  const nonzero = train.filter((quantity) => cmp(quantity, ZERO) > 0);
  if (nonzero.length === 0) {
    return { method: "croston_sba", fitted: train.map(() => ZERO), forecast: (steps) => Array.from({ length: steps }, () => ZERO) };
  }
  let size = nonzero[0]!;
  let interval = div(String(train.length), String(nonzero.length));
  let since = 0;
  const fitted: string[] = [];
  const rate = () => mul(size, div(ONE, interval));
  for (const quantity of train) {
    since += 1;
    fitted.push(mul(rate(), sub(ONE, div(CROSTON_ALPHA, "2"))));
    if (cmp(quantity, ZERO) > 0) {
      size = add(mul(CROSTON_ALPHA, quantity), mul(sub(ONE, CROSTON_ALPHA), size));
      interval = add(
        mul(CROSTON_ALPHA, String(since)),
        mul(sub(ONE, CROSTON_ALPHA), interval),
      );
      since = 0;
    }
  }
  const level = mul(rate(), sub(ONE, div(CROSTON_ALPHA, "2")));
  return {
    method: "croston_sba",
    fitted,
    forecast: (steps: number) => Array.from({ length: steps }, () => level),
  };
}

/** Holdout MAE of one fit: fit on the head, score on the tail. */
function holdoutMae(
  corrected: readonly string[],
  holdoutWeeks: number,
  fit: (train: readonly string[]) => Fit | null,
): string | null {
  if (corrected.length <= holdoutWeeks) return null;
  const train = corrected.slice(0, corrected.length - holdoutWeeks);
  const holdout = corrected.slice(corrected.length - holdoutWeeks);
  const fitted = fit(train);
  if (!fitted) return null;
  return mae(holdout, fitted.forecast(holdout.length));
}

function candidateFits(
  corrected: readonly string[],
  preference: ForecastMethodPreference,
): Array<(train: readonly string[]) => Fit | null> {
  const seasonal132: Array<(train: readonly string[]) => Fit | null> = [
    (train) => fitSeasonal(train, 13, false),
    (train) => fitSeasonal(train, 13, true),
  ];
  const seasonal522: Array<(train: readonly string[]) => Fit | null> = [
    (train) => fitSeasonal(train, 52, false),
    (train) => fitSeasonal(train, 52, true),
  ];
  if (preference === "average") return [fitMovingAverage];
  if (preference === "intermittent") return [fitCrostonSba, fitMovingAverage];
  if (preference === "seasonal") return [...seasonal522, ...seasonal132, fitMovingAverage];
  const long = corrected.length >= 78 ? seasonal522 : [];
  const medium = corrected.length >= 26 ? seasonal132 : [];
  return [...long, ...medium, fitCrostonSba, fitMovingAverage];
}

/**
 * Intermittent demand (many zero weeks, or a long average interval between
 * sales) forecasts with Croston/SBA by regime, not by horse-race: Croston
 * and a moving average both forecast flat, so on uniformly spaced bursts
 * the race cannot separate them and the bias-corrected intermittent method
 * is the safer default. Every other regime picks by holdout error.
 */
export function isIntermittentDemand(quantities: readonly string[]): boolean {
  if (quantities.length === 0) return false;
  return zeroShare(quantities) >= 0.4 || cmp(averageDemandInterval(quantities), "1.32") > 0;
}

/**
 * Normal quantiles for the service levels operators actually pick, with
 * exact-decimal linear interpolation between them. A service level outside
 * 50–99.9% is refused by the policy check before it reaches here; anything
 * below the table floor reads as zero safety, never as a negative one.
 */
const SERVICE_Z: ReadonlyArray<readonly [string, string]> = [
  ["0.5", "0"],
  ["0.8", "0.8416"],
  ["0.9", "1.2816"],
  ["0.95", "1.6449"],
  ["0.975", "1.96"],
  ["0.99", "2.3263"],
  ["0.999", "3.0902"],
];

export function zForServiceLevel(serviceLevel: string): string {
  if (cmp(serviceLevel, SERVICE_Z[0]![0]) <= 0) return ZERO;
  for (let index = 1; index < SERVICE_Z.length; index++) {
    const [level, z] = SERVICE_Z[index]!;
    if (cmp(serviceLevel, level) <= 0) {
      const [previousLevel, previousZ] = SERVICE_Z[index - 1]!;
      const span = sub(level, previousLevel);
      const weight = div(sub(serviceLevel, previousLevel), span);
      return add(previousZ, mul(weight, sub(z, previousZ)));
    }
  }
  return SERVICE_Z[SERVICE_Z.length - 1]![1];
}

/**
 * 1-based month that averaged the highest corrected demand — the "seasonal
 * peak in Nov" line. Computed from history means, not from fitted indices,
 * so it stays truthful even when the winning method is not seasonal.
 */
function peakDemandMonth(weekStarts: readonly string[], quantities: readonly string[]): number | null {
  if (weekStarts.length === 0) return null;
  const byMonth = new Map<string, string[]>();
  for (let index = 0; index < weekStarts.length; index++) {
    const month = weekStarts[index]!.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), quantities[index]!]);
  }
  let peak: string | null = null;
  let peakMean = ZERO;
  let first = true;
  for (const [month, values] of byMonth) {
    const average = mean(values);
    if (first || cmp(average, peakMean) > 0) {
      peak = month;
      peakMean = average;
      first = false;
    }
  }
  if (peak === null) return null;
  const month = Number(peak.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

/** Forecast `horizonWeeks` weekly periods from corrected demand history. */
export function forecastDemand(
  weeks: readonly DemandWeek[],
  options: ForecastOptions,
): ForecastResult {
  if (!Number.isInteger(options.horizonWeeks) || options.horizonWeeks < 1 || options.horizonWeeks > 52) {
    throw new Error("forecast horizon must be from 1 to 52 weeks");
  }
  if (weeks.length === 0) {
    throw new Error("a forecast needs at least one week of demand history");
  }
  const preference = options.method ?? "auto";
  const weekStarts = weeks.map((week) => week.weekStart);
  const { corrected, imputed } = imputeStockouts(weeks);
  const windows = options.promotionWindows ?? [];
  const lift = measurePromotionLift(weekStarts, corrected, windows);
  const dePromoted = lift.factor && cmp(lift.factor, ZERO) > 0
    ? corrected.map((quantity, index) =>
        promotionWeeksOf([weekStarts[index]!], windows).size > 0 ? div(quantity, lift.factor!) : quantity,
      )
    : [...corrected];
  const historyWeeks = dePromoted.length;
  const holdoutWeeks = historyWeeks >= 8 ? Math.min(13, Math.max(4, Math.floor(historyWeeks / 4))) : 0;
  const candidates = candidateFits(dePromoted, preference);
  const scored = candidates
    .map((fit) => {
      const probe = fit(dePromoted);
      if (!probe) return null;
      const score = holdoutWeeks > 0 ? holdoutMae(dePromoted, holdoutWeeks, fit) : mae(dePromoted, probe.fitted);
      return { fit: probe, score: score ?? mae(dePromoted, probe.fitted) };
    })
    .filter((entry): entry is { fit: Fit; score: string } => entry !== null);
  if (scored.length === 0) throw new Error("no forecast method fits this demand history");
  scored.sort((a, b) => (cmp(a.score, b.score) === 0 ? a.fit.method.localeCompare(b.fit.method) : cmp(a.score, b.score)));
  const croston = scored.find((entry) => entry.fit.method === "croston_sba");
  const winner = preference === "auto" && croston && isIntermittentDemand(dePromoted)
    ? croston
    : scored[0]!;
  const seasonalPeriod = winner.fit.method.startsWith("seasonal") && historyWeeks >= 78 ? 52
    : winner.fit.method.startsWith("seasonal") ? 13
    : null;
  const sigma = decimalStd(
    dePromoted.map((quantity, index) => sub(quantity, winner.fit.fitted[index] ?? quantity)),
  );
  const bandZ = options.bandZ ?? "1.2816";
  const uplift = new Set(options.plannedPromotionWeeks ?? []);
  const lastWeek = weekStarts[weekStarts.length - 1];
  const horizonStarts: string[] = [];
  for (let step = 1; step <= options.horizonWeeks; step++) {
    horizonStarts.push(lastWeek ? addCalendarDays(lastWeek, step * 7) : addCalendarDays(weekStarts[0]!, step * 7));
  }
  const raw = winner.fit.forecast(options.horizonWeeks);
  const periods = raw.map((quantity, step) => {
    const lifted = lift.factor && uplift.has(horizonStarts[step]!) ? mul(quantity, lift.factor) : quantity;
    const floored = cmp(lifted, ZERO) < 0 ? ZERO : lifted;
    const band = mul(bandZ, sigma);
    return {
      periodStart: horizonStarts[step]!,
      quantity: floored,
      lower: cmp(sub(floored, band), ZERO) < 0 ? ZERO : sub(floored, band),
      upper: add(floored, band),
      method: winner.fit.method,
    };
  });
  return {
    periods,
    explanation: {
      method: winner.fit.method,
      historyWeeks,
      holdoutWeeks,
      holdoutMaeByMethod: Object.fromEntries(scored.map((entry) => [entry.fit.method, entry.score])),
      stockoutWeeksImputed: imputed,
      seasonalPeakMonth: peakDemandMonth(weekStarts, corrected),
      seasonalPeriodWeeks: seasonalPeriod,
      promotionCode: lift.code,
      promotionLiftFactor: lift.factor,
      promotionIgnoredReason: lift.ignoredReason,
      residualSigma: sigma,
    },
  };
}
