/**
 * Exact overhead-rate derivation — the ONE calculation contract for the True
 * Cost preview and overhead publication.
 *
 * True Cost used to convert money to JavaScript numbers, divide and aggregate
 * them, and publication converted the float back with
 * `formatMoney(String(composite), 2)` — which THROWS on ordinary repeating
 * decimals (`String(100 / 3)` is not valid money input) and drifts on the
 * rest. Every function here is string-in/string-out exact decimal arithmetic
 * on `engine/src/money/money.ts` primitives; IEEE-754 floats never appear.
 *
 * Precision and rounding policy (also stated in the Overhead Model
 * help-center article):
 * - Category/department rates are exact to 4 decimals (`OVERHEAD_RATE_INTERNAL_DECIMALS`),
 *   halves away from zero (`money.div`).
 * - Published per-hour card rates round once to 2 decimals
 *   (`OVERHEAD_RATE_PUBLISH_DECIMALS`), halves away from zero
 *   (`money.formatMoney`). No double rounding: the 2dp card derives from the
 *   exact 4dp rate, never from a displayed value.
 * - GL-sourced money inputs must already be ledger-exact (4dp or fewer);
 *   anything else fails closed. Allocation-base inputs (hours, headcounts,
 *   config overrides) and synthetic category expenses are quantized exactly
 *   from their shortest-repr decimal to 4dp via `quantizeOverheadMoney`
 *   (half away, no float) — a no-op for exact inputs.
 *
 * Method contract (preview and publication share it, so the Matrix preview
 * can never disagree with the published card):
 * - Per-department category rates honor the allocation method. `simple`
 *   divides exactly; `weighted` divides exactly per department (a department
 *   positive weight cancels within its own rate — the Overall weighted rate is the
 *   base-and-weight-weighted mean of these department rates, pinned by test);
 *   `stepped` resolves the tier by the DEPARTMENT base and falls back to
 *   exact division outside every tier.
 * - Per-department composites honor the composite method: `sum` adds the
 *   included category rates, `weighted` takes their expense-weighted mean,
 *   `cascading` runs them over the department labor rate in cascade order
 *   (percent-format categories compound, absolute ones add), mirroring the
 *   Overall headline semantics per department.
 * - Only `per_hour` categories can publish: the card is `rate_kind =
 *   'per_hour'`, so blending a non-hourly display rate into it is a unit
 *   error. `overheadPublishBlockers` is the single gate — derivation throws
 *   `UnsupportedOverheadRateError` through it, and publication refuses with
 *   the same list. Excluded (`includeInComposite: false`) categories never
 *   block.
 *
 * Doctrine: overhead is statistical and posts only as the net-zero pair.
 * This module derives rates; it never touches labor postings.
 */
import {
  add,
  cmp,
  div,
  formatMoney,
  fromUnits,
  normalizeMoney,
  roundDiv,
  toUnits,
} from "../money/money.ts";
import type { Rate } from "../money/brands.ts";

export type OverheadRateMethod = "simple" | "weighted" | "stepped";
export type OverheadCompositeMethod = "sum" | "weighted" | "cascading";
export type OverheadRateFormat =
  "per_hour"
  | "percent_labor"
  | "percent_cost"
  | "per_fte"
  | "per_unit";

/** Internal rate precision: exact to ledger decimals. */
export const OVERHEAD_RATE_INTERNAL_DECIMALS = 4;
/** Published card precision: per-hour rates persist at cents. */
export const OVERHEAD_RATE_PUBLISH_DECIMALS = 2;

const ZERO_4 = "0.0000";

export interface OverheadTier {
  min?: number | string;
  max?: number | string;
  rate?: number | string;
}

export interface OverheadCategoryDeptInput {
  id: string;
  allocationMethod: OverheadRateMethod;
  allocationTiers?: OverheadTier[];
  allocationWeights?: Record<string, number | string>;
  /** Exact money strings (GL-sourced) or `quantizeOverheadMoney` output. */
  expenseByDept: Record<string, string>;
  /** Decimal strings in the category's allocation-base units. */
  baseByDept: Record<string, string>;
}

export interface OverheadCompositeCategory {
  id: string;
  /** Display name for refusal messages; falls back to the id. */
  name?: string;
  /** Exact 4dp department rate in the category's display units. */
  rate: string;
  /** Exact 4dp expense attributed to the department. */
  expense: string;
  rateFormat: OverheadRateFormat;
  includeInComposite: boolean;
}

export interface OverheadDeptCompositeInput {
  compositeMethod: OverheadCompositeMethod;
  cascadeOrder?: string[];
  /**
   * Department labor rate (exact money string), measured from costed time or
   * set explicitly on the profile. Required for cascading; unused otherwise.
   * There is no default: an assumed rate would price every cascade.
   */
  baseLaborRate?: string | number;
  categories: OverheadCompositeCategory[];
}

export interface OverheadPublishCategory {
  id: string;
  name?: string;
  rateFormat: OverheadRateFormat;
  includeInComposite: boolean;
}

export interface OverheadPublishBlocker {
  categoryId: string;
  reason: string;
}

export class UnsupportedOverheadRateError extends Error {
  readonly blockers: OverheadPublishBlocker[];
  constructor(blockers: OverheadPublishBlocker[]) {
    super(
      `overhead rates cannot publish: ${blockers
        .map((b) => b.reason)
        .join("; ")}`,
    );
    this.name = "UnsupportedOverheadRateError";
    this.blockers = blockers;
  }
}

interface ExpandedDecimal {
  negative: boolean;
  /** All significant digits, whole then fraction, without sign or point. */
  digits: string;
  /** Count of `digits` that sit left of the decimal point (may be <= 0). */
  point: number;
}

/**
 * Expand a finite decimal to raw digits without any precision cap, so
 * float-artifact inputs (up to 17 significant digits, possibly exponent
 * form) stay exact. Fails closed on non-decimals and on magnitudes that
 * would amplify the digit string absurdly.
 */
function expandDecimal(value: string | number): ExpandedDecimal {
  const original = String(value);
  let raw = original.trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
    throw new Error(`not a decimal number: "${original}"`);
  }
  const negative = raw.startsWith("-");
  raw = raw.replace(/^[-+]/, "");
  let exponent = 0;
  const match = raw.match(/[eE]([-+]?\d+)$/);
  if (match) {
    exponent = Number(match[1]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
      throw new Error(`decimal exponent out of supported range: "${original}"`);
    }
    raw = raw.slice(0, match.index);
  }
  const dot = raw.indexOf(".");
  const whole = dot === -1 ? raw : raw.slice(0, dot);
  const fraction = dot === -1 ? "" : raw.slice(dot + 1);
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  if (point > 40 || point < -40 || digits.length > 60) {
    throw new Error(`decimal magnitude out of supported range: "${original}"`);
  }
  return { negative, digits, point };
}

function splitMagnitude(e: ExpandedDecimal): { int: string; frac: string } {
  let int: string;
  let frac: string;
  if (e.point <= 0) {
    int = "0";
    frac = `${"0".repeat(-e.point)}${e.digits}`;
  } else if (e.point >= e.digits.length) {
    int = `${e.digits}${"0".repeat(e.point - e.digits.length)}`;
    frac = "";
  } else {
    int = e.digits.slice(0, e.point);
    frac = e.digits.slice(e.point);
  }
  int = int.replace(/^0+(?=\d)/, "");
  return { int: int === "" ? "0" : int, frac };
}

/**
 * Round a finite decimal to 4dp, halves away from zero, as an exact string
 * operation — never through a float. Accepts shortest-repr config and
 * synthetic-category values (including float artifacts and exponent form);
 * idempotent on exact money strings. Fails closed on non-decimals.
 */
export function quantizeOverheadMoney(value: string | number): string {
  const expanded = expandDecimal(value);
  const { int, frac } = splitMagnitude(expanded);
  const padded = `${frac}00000`;
  const keep = padded.slice(0, OVERHEAD_RATE_INTERNAL_DECIMALS);
  const rest = padded.slice(OVERHEAD_RATE_INTERNAL_DECIMALS);
  const len = Math.max(rest.length, 1);
  const restFixed = (rest + "0".repeat(len)).slice(0, len);
  const halfFixed = `5${"0".repeat(len - 1)}`;
  let units = BigInt(int) * 10_000n + BigInt(keep === "" ? "0" : keep);
  if (restFixed >= halfFixed) units += 1n;
  if (units === 0n) return ZERO_4;
  const out = `${units / 10_000n}.${(units % 10_000n).toString().padStart(4, "0")}`;
  return expanded.negative ? `-${out}` : out;
}

/** Exact sign of (a − b) for finite decimal strings. No float. */
export function compareOverheadDecimals(a: string | number, b: string | number): number {
  const left = expandDecimal(a);
  const right = expandDecimal(b);
  const l = splitMagnitude(left);
  const r = splitMagnitude(right);
  const isZero = (m: { int: string; frac: string }): boolean =>
    /^0*$/.test(m.int) && !/[1-9]/.test(m.frac);
  if (isZero(l) && isZero(r)) return 0;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  let mag = 0;
  if (l.int.length !== r.int.length) {
    mag = l.int.length < r.int.length ? -1 : 1;
  } else if (l.int !== r.int) {
    mag = l.int < r.int ? -1 : 1;
  } else {
    const width = Math.max(l.frac.length, r.frac.length);
    const lf = (l.frac + "0".repeat(width)).slice(0, width);
    const rf = (r.frac + "0".repeat(width)).slice(0, width);
    mag = lf === rf ? 0 : lf < rf ? -1 : 1;
  }
  return left.negative ? -mag : mag;
}

/**
 * Exact per-department category rates (4dp strings) honoring the allocation
 * method. Departments present in either map participate; a non-positive base
 * yields zero (mirrors the legacy `deptBase > 0` guard).
 */
// Every rate below is fixed-4dp text (quantize/div/ZERO_4): canonical Rate.
export function deriveOverheadCategoryDeptRates(
  input: OverheadCategoryDeptInput,
): Record<string, Rate> {
  const deptIds = [...new Set([...Object.keys(input.expenseByDept), ...Object.keys(input.baseByDept)])].sort();
  const out: Record<string, Rate> = {};
  if (input.allocationMethod === "stepped" && (input.allocationTiers?.length ?? 0) > 0) {
    const tiers = [...(input.allocationTiers ?? [])].sort((a, b) =>
      compareOverheadDecimals(a.min ?? 0, b.min ?? 0),
    );
    for (const deptId of deptIds) {
      const base = quantizeOverheadMoney(input.baseByDept[deptId] ?? "0");
      // quantizeOverheadMoney emits fixed 4dp: a canonical Rate.
      let matched: Rate | null = null;
      for (let i = tiers.length - 1; i >= 0; i -= 1) {
        const tier = tiers[i];
        if (!tier) continue;
        const min = tier.min === undefined || tier.min === null || tier.min === "" ? "0" : String(tier.min);
        const max = tier.max === undefined || tier.max === null || tier.max === "" ? null : String(tier.max);
        if (compareOverheadDecimals(base, min) < 0) continue;
        if (max !== null && compareOverheadDecimals(base, max) > 0) continue;
        if (compareOverheadDecimals(String(tier.rate ?? 0), "0") <= 0) continue;
        matched = quantizeOverheadMoney(String(tier.rate ?? 0)) as Rate;
        break;
      }
      if (matched !== null) {
        out[deptId] = matched;
        continue;
      }
      out[deptId] = (
        compareOverheadDecimals(base, "0") > 0
          ? div(input.expenseByDept[deptId] ?? ZERO_4, base)
          : ZERO_4
      ) as Rate;
    }
    return out;
  }
  // simple: exact division. weighted: a department weight multiplies its own
  // expense AND its own base, so a positive weight cancels — the per-department weighted
  // rate IS the exact division (the Overall weighted headline is the
  // base-and-weight-weighted mean of these, pinned by test).
  for (const deptId of deptIds) {
    if (input.allocationMethod === "weighted") {
      const weight = quantizeOverheadMoney(input.allocationWeights?.[deptId] ?? 1);
      if (cmp(weight, "0") < 0) throw new OverheadCalculationError(`Category "${input.id}" has a negative department weight. Correct the allocation weights before retrying.`);
      if (cmp(weight, "0") === 0) { out[deptId] = ZERO_4 as Rate; continue; }
    }
    const base = quantizeOverheadMoney(input.baseByDept[deptId] ?? "0");
    out[deptId] = (
      compareOverheadDecimals(base, "0") > 0
        ? div(input.expenseByDept[deptId] ?? ZERO_4, base)
        : ZERO_4
    ) as Rate;
  }
  return out;
}

/** Overall uses the same tier resolver as department rates, with exact weighted inputs. */
export function deriveOverheadOverallRate(
  input: OverheadCategoryDeptInput & {
    allocationWeights?: Record<string, number | string>;
  },
): Rate {
  let expense = ZERO_4;
  let base = ZERO_4;
  if (input.allocationMethod === "weighted") {
    let numerator = 0n;
    let denominator = 0n;
    for (const id of new Set([
      ...Object.keys(input.expenseByDept),
      ...Object.keys(input.baseByDept),
    ])) {
      const weight = toUnits(
        quantizeOverheadMoney(input.allocationWeights?.[id] ?? 1),
      );
      if (weight < 0n)
        throw new OverheadCalculationError(
          `Category "${input.id}" has a negative department weight. Correct the allocation weights before retrying.`,
        );
      numerator += toUnits(input.expenseByDept[id] ?? ZERO_4) * weight;
      denominator +=
        toUnits(quantizeOverheadMoney(input.baseByDept[id] ?? ZERO_4)) * weight;
    }
    return (
      denominator > 0n
        ? fromUnits(roundDiv(numerator * 10_000n, denominator))
        : ZERO_4
    ) as Rate;
  }
  for (const value of Object.values(input.expenseByDept))
    expense = add(expense, value);
  for (const value of Object.values(input.baseByDept))
    base = add(base, quantizeOverheadMoney(value));
  return deriveOverheadCategoryDeptRates({
    ...input,
    expenseByDept: { Overall: expense },
    baseByDept: { Overall: base },
  }).Overall!;
}

/**
 * Machine-readable refusal codes for the composite/KPI-level refusals the
 * True Cost loader surfaces without blanking the dashboard. The message
 * stays the human-readable English diagnostic the engine contract tests
 * pin; the loader maps the code to a catalogued translation carrying the
 * real category and department names.
 */
export type OverheadRefusalCode =
  | "mixedUnits"
  | "cascadingNoLabor"
  | "perFteNoHours"
  | "missingBase"
  | "formulaReference"
  | "formulaNegative"
  | "unreadableAmount";

export class OverheadCalculationError extends Error {
  readonly status = 422;
  readonly code?: OverheadRefusalCode;
  readonly values?: Record<string, string>;
  constructor(message: string, code?: OverheadRefusalCode, values?: Record<string, string>) {
    super(message);
    this.name = "OverheadCalculationError";
    this.code = code;
    this.values = values;
  }
}

/** Null means an undefined ratio, never a fabricated denominator or zero rate. */
export function deriveOverheadDisplayRate(input: {
  rawRate: string;
  expense: string;
  rateFormat: OverheadRateFormat;
  laborDollars?: string;
  directCost?: string;
  units?: string;
  /**
   * Annual hours per FTE, resolved from work schedules or labor cost rates.
   * Required for per_fte: without it the category refuses instead of
   * assuming a divisor.
   */
  annualFteHours?: string;
}): string | null {
  if (input.rateFormat === "per_hour") return input.rawRate;
  if (input.rateFormat === "per_fte") {
    if (input.annualFteHours === undefined || input.annualFteHours === null || String(input.annualFteHours).trim() === "")
      throw new OverheadCalculationError(
        "Cannot calculate Currency/FTE: no annual FTE hours were resolved — record annual hours on the employees' labor cost rates or weekly hours on their work schedules.",
        "perFteNoHours",
      );
    return fromUnits(
      roundDiv(
        toUnits(input.rawRate) * toUnits(input.annualFteHours),
        10_000n,
      ),
    );
  }
  const denominator =
    input.rateFormat === "percent_labor"
      ? input.laborDollars
      : input.rateFormat === "percent_cost"
        ? input.directCost
        : input.units;
  if (denominator === undefined || cmp(denominator, "0") <= 0) return null;
  const multiplier = input.rateFormat === "per_unit" ? 1n : 100n;
  return fromUnits(
    roundDiv(
      toUnits(input.expense) * 10_000n * multiplier,
      toUnits(denominator),
    ),
  );
}

/**
 * Exact per-department composite (4dp string) honoring the composite method,
 * mirroring the Overall headline semantics per department. Only included
 * categories participate.
 */
export function deriveOverheadDeptComposite(input: OverheadDeptCompositeInput): Rate {
  const included = input.categories.filter((c) => c.includeInComposite);
  // Every exit below is fixed-4dp text (literals, add-chains, fromUnits).
  if (included.length === 0) return ZERO_4 as Rate;
  // Sum and weighted blending add DISPLAY rates: percent-point rates and
  // per-hour (or per-FTE, per-unit) rates are different units, so a mixed
  // blend is refused with the categories named instead of shown as "/hr".
  // (Cascading defines its own percent/absolute semantics below.)
  if (input.compositeMethod === "sum" || input.compositeMethod === "weighted") {
    const byFormat = new Map<OverheadRateFormat, string[]>();
    for (const c of included) {
      const list = byFormat.get(c.rateFormat) ?? [];
      list.push(c.name ? `"${c.name}"` : c.id);
      byFormat.set(c.rateFormat, list);
    }
    if (byFormat.size > 1) {
      const parts = [...byFormat.entries()].map(([format, names]) => `${format} (${names.join(", ")})`);
      throw new OverheadCalculationError(
        `Cannot blend rate formats in one ${input.compositeMethod} composite: ${parts.join("; ")} — ` +
          `give every included category the same rate format, or exclude the odd ones from the composite.`,
        "mixedUnits",
      );
    }
  }
  switch (input.compositeMethod) {
    case "sum": {
      let total = ZERO_4;
      for (const c of included) total = add(total, c.rate);
      return total as Rate;
    }
    case "weighted": {
      let expenseTotal = ZERO_4;
      for (const c of included) expenseTotal = add(expenseTotal, c.expense);
      if (cmp(expenseTotal, "0") <= 0) return ZERO_4 as Rate;
      let weightedUnits = 0n;
      for (const c of included) weightedUnits += toUnits(c.rate) * toUnits(c.expense);
      return fromUnits(roundDiv(weightedUnits, toUnits(expenseTotal))) as Rate;
    }
    case "cascading": {
      if (input.baseLaborRate === undefined || input.baseLaborRate === null || String(input.baseLaborRate).trim() === "")
        throw new OverheadCalculationError(
          "The cascading composite needs a labor rate but the period has no costed labor and the profile sets no base labor rate — approve costed time for the period or set a base labor rate on the True Cost profile.",
          "cascadingNoLabor",
        );
      const base = normalizeMoney(input.baseLaborRate);
      const baseUnits = toUnits(base);
      let running = baseUnits;
      const order = input.cascadeOrder ?? included.map((c) => c.id);
      for (const id of order) {
        const c = included.find((x) => x.id === id);
        if (!c) continue;
        const rateUnits = toUnits(c.rate);
        if (c.rateFormat === "percent_labor" || c.rateFormat === "percent_cost") {
          // rate is percent points in 1e-4 units: factor = 1 + p/100.
          running = roundDiv(running * (1_000_000n + rateUnits), 1_000_000n);
        } else {
          running += rateUnits;
        }
      }
      return fromUnits(running - baseUnits) as Rate;
    }
  }
}

/** Round an exact 4dp department composite to the published 2dp card rate. */
export function formatOverheadPublishRate(composite4dp: string): string {
  return formatMoney(composite4dp, OVERHEAD_RATE_PUBLISH_DECIMALS);
}

/**
 * The single publish gate: included categories whose configured output is not
 * an hourly rate cannot blend into a `per_hour` card (unit error), so
 * publication refuses them explicitly instead of silently summing ratios.
 */
export function overheadPublishBlockers(
  categories: OverheadPublishCategory[],
): OverheadPublishBlocker[] {
  const out: OverheadPublishBlocker[] = [];
  for (const c of categories) {
    if (!c.includeInComposite) continue;
    if (c.rateFormat !== "per_hour") {
      const label = c.name ? `"${c.name}"` : c.id;
      out.push({
        categoryId: c.id,
        reason:
          `category ${label} uses rate format "${c.rateFormat}", which cannot publish ` +
          `to the per-hour rate card (switch it to Currency/Hour or exclude it from the composite)`,
      });
    }
  }
  return out;
}

/** Throw `UnsupportedOverheadRateError` when the gate blocks publication. */
export function assertOverheadRatesPublishable(categories: OverheadPublishCategory[]): void {
  const blockers = overheadPublishBlockers(categories);
  if (blockers.length > 0) throw new UnsupportedOverheadRateError(blockers);
}
