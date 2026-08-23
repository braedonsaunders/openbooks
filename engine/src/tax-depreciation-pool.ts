/**
 * Generic TAX depreciation pool engine (jurisdiction-neutral).
 *
 * Many tax regimes depreciate assets not individually but as CLASS POOLS: all
 * assets of a class share one running "written-down value" that depreciates on a
 * declining balance each year, with additions/disposals flowing through the pool
 * and regime-specific first-year and disposal rules. Canada's Capital Cost
 * Allowance (CCA/UCC) is one such regime; the UK's writing-down allowances
 * (main/special pools) and Australia's low-value pools are others. This engine
 * is the regime-neutral math; each regime is CONFIGURATION DATA (see
 * TAX_DEPRECIATION_REGIMES), never hardcoded logic.
 *
 * Annual waterfall:
 *   1. balance = opening + additions − dispositions(lesser of proceeds & cost)
 *   2. balance < 0 (regime allows) → RECAPTURE / balancing charge (income); reset 0
 *   3. pool empty but balance > 0 → TERMINAL LOSS / balancing allowance; reset 0
 *   4. else base = balance − immediate-expense, adjusted for the first-year
 *      fraction OR an enhanced first-year multiplier; allowance = base × rate ×
 *      short-year factor, capped at available balance and any discretionary cap
 *   5. closing = balance − immediate-expense − allowance
 *
 * First-year fractions and enhanced multipliers are INPUTS (from dated config),
 * because they change by legislation (e.g. Canada's half-year rule vs. the
 * Accelerated Investment Incentive).
 */

import { add, cmp, formatMoney, fromUnits, mulDecimal, mulDecimalFactors, mulPercent, neg, normalizeMoney, roundDiv, roundMoney, sum, toUnits } from "./money.ts";
import { canonicalDecimal } from "./exact-decimal.ts";
import { taxConventionHalfMonths } from "./depreciation-conventions.ts";

type ExactDecimal = string | number;

export interface PoolClassDef {
  /** Regime class code — CA "8"/"10.1", UK "main"/"special". */
  code: string;
  rate: ExactDecimal;
  method: "declining" | "straight_line";
  /** Fraction of net additions eligible in the acquisition year: 1 = full,
   *  0.5 = Canada's half-year rule. */
  firstYearFraction: ExactDecimal;
  /** Disposal can push the pool negative into taxable income (Canada recapture,
   *  UK balancing charge). */
  allowRecapture: boolean;
  /** Emptying the pool with a positive balance yields a deduction (Canada
   *  terminal loss, UK balancing allowance). */
  allowTerminalLoss: boolean;
  /** Per-item capital-cost ceiling (e.g. Canada Class 10.1 / 54 vehicles). */
  costCap?: ExactDecimal;
  /** Per-asset MACRS configuration; omitted for pooled regimes. */
  depreciationSystem?: "gds" | "ads";
  macrsMethod?: "200_db" | "150_db" | "straight_line";
  recoveryPeriodYears?: ExactDecimal;
  convention?: "half_year" | "mid_quarter" | "mid_month";
  name: string;
}

export interface TaxDepreciationRegime {
  code: string;
  name: string;
  countryCode: string;
  calculationModel: "pool" | "macrs";
  classAttribute: string;
  classes: Record<string, PoolClassDef>;
}

/** Built-in regimes as data. Add a jurisdiction = add an entry, not code. */
export const TAX_DEPRECIATION_REGIMES: Record<string, TaxDepreciationRegime> = {
  ca_cca: {
    code: "ca_cca",
    name: "Canada — Capital Cost Allowance",
    countryCode: "CA",
    calculationModel: "pool",
    classAttribute: "ca_cca_class",
    classes: caClass({
      "1": [0.04, "Buildings (post-1987)"],
      "3": [0.05, "Buildings (pre-1988)"],
      "8": [0.2, "Furniture, equipment, machinery"],
      "10": [0.3, "Vehicles, general"],
      "12": [1.0, "Tools, software, small items", { firstYearFraction: 1 }],
      "13": [0, "Leasehold improvements", { firstYearFraction: 1, method: "straight_line" }],
      "14": [0, "Limited-life intangibles", { firstYearFraction: 1, method: "straight_line" }],
      "14.1": [0.05, "Goodwill & unlimited-life intangibles"],
      "16": [0.4, "Taxis, rental & freight vehicles"],
      "43": [0.3, "Manufacturing & processing equipment"],
      "43.1": [0.3, "Clean-energy equipment"],
      "43.2": [0.5, "Clean-energy equipment (2005–2024)"],
      "50": [0.55, "Computer hardware & systems software"],
      "53": [0.5, "Manufacturing equipment (2016–2025)"],
      "54": [0.3, "Zero-emission passenger vehicles", { costCap: 61000 }],
      "55": [0.4, "Zero-emission vehicles (Class 16 type)"],
      "56": [0.3, "Zero-emission automotive equipment"],
      "10.1": [0.3, "Passenger vehicles (over ceiling)", { costCap: 37000, allowRecapture: false, allowTerminalLoss: false }],
    }),
  },
  uk_wda: {
    code: "uk_wda",
    name: "United Kingdom — Writing-Down Allowances",
    countryCode: "GB",
    calculationModel: "pool",
    classAttribute: "tax_pool_class",
    classes: {
      main: fullYear("main", 0.18, "Main rate pool"),
      special: fullYear("special", 0.06, "Special rate pool"),
      sba: { code: "sba", rate: 0.03, method: "straight_line", firstYearFraction: 1, allowRecapture: false, allowTerminalLoss: false, name: "Structures & buildings allowance" },
    },
  },
  au_pool: {
    code: "au_pool",
    name: "Australia — Depreciation Pools",
    countryCode: "AU",
    calculationModel: "pool",
    classAttribute: "tax_pool_class",
    classes: {
      // Diminishing-value pools: half the pool rate in the year of allocation.
      sbp: { code: "sbp", rate: 0.3, method: "declining", firstYearFraction: 0.5, allowRecapture: true, allowTerminalLoss: true, name: "Small business pool (15% then 30%)" },
      lvp: { code: "lvp", rate: 0.375, method: "declining", firstYearFraction: 0.5, allowRecapture: true, allowTerminalLoss: true, name: "Low-value pool (18.75% then 37.5%)" },
    },
  },
  nz_pool: {
    code: "nz_pool",
    name: "New Zealand — Pool method",
    countryCode: "NZ",
    calculationModel: "pool",
    classAttribute: "tax_pool_class",
    classes: {
      // The pool depreciates at the lowest DV rate of its assets; a maintained
      // default the tenant tunes per pool (see Tax Setup → pool classes).
      pool: fullYear("pool", 0.1, "Pooled assets (diminishing value)"),
    },
  },
  us_macrs: {
    code: "us_macrs",
    name: "United States — MACRS",
    countryCode: "US",
    calculationModel: "macrs",
    classAttribute: "us_macrs_class",
    classes: {
      gds_3: macrs("gds_3", 3, "200_db", "half_year", "3-year property"),
      gds_5: macrs("gds_5", 5, "200_db", "half_year", "5-year property"),
      gds_7: macrs("gds_7", 7, "200_db", "half_year", "7-year property"),
      gds_10: macrs("gds_10", 10, "200_db", "half_year", "10-year property"),
      gds_15: macrs("gds_15", 15, "150_db", "half_year", "15-year property"),
      gds_20: macrs("gds_20", 20, "150_db", "half_year", "20-year property"),
      residential_rental: macrs("residential_rental", 27.5, "straight_line", "mid_month", "Residential rental property"),
      nonresidential_real: macrs("nonresidential_real", 39, "straight_line", "mid_month", "Nonresidential real property"),
      ads_5: macrs("ads_5", 5, "straight_line", "half_year", "ADS 5-year property", "ads"),
      ads_10: macrs("ads_10", 10, "straight_line", "half_year", "ADS 10-year property", "ads"),
      ads_12: macrs("ads_12", 12, "straight_line", "half_year", "ADS 12-year property", "ads"),
      ads_15: macrs("ads_15", 15, "straight_line", "half_year", "ADS 15-year property", "ads"),
      ads_20: macrs("ads_20", 20, "straight_line", "half_year", "ADS 20-year property", "ads"),
      ads_25: macrs("ads_25", 25, "straight_line", "half_year", "ADS 25-year property", "ads"),
      ads_30_real: macrs("ads_30_real", 30, "straight_line", "mid_month", "ADS residential rental property", "ads"),
      ads_40_real: macrs("ads_40_real", 40, "straight_line", "mid_month", "ADS nonresidential real property", "ads"),
    },
  },
};

function macrs(
  code: string,
  recoveryPeriodYears: ExactDecimal,
  macrsMethod: "200_db" | "150_db" | "straight_line",
  convention: "half_year" | "mid_quarter" | "mid_month",
  name: string,
  depreciationSystem: "gds" | "ads" = "gds",
): PoolClassDef {
  return {
    // MACRS uses the method + recovery period below; this display/config rate
    // is deliberately not calculated with a JavaScript binary float.
    code, name, rate: exactRatio(macrsMethod === "200_db" ? 2n : macrsMethod === "150_db" ? 3n : 1n, macrsMethod === "150_db" ? 2n : 1n, recoveryPeriodYears),
    method: macrsMethod === "straight_line" ? "straight_line" : "declining",
    firstYearFraction: convention === "half_year" ? 0.5 : 1,
    allowRecapture: false, allowTerminalLoss: false,
    depreciationSystem, macrsMethod, recoveryPeriodYears, convention,
  };
}

/** A full-year regime class (no half-year rule): first-year fraction 1. */
function fullYear(code: string, rate: ExactDecimal, name: string): PoolClassDef {
  return { code, rate, method: "declining", firstYearFraction: 1, allowRecapture: true, allowTerminalLoss: true, name };
}

/** Build Canada class defs with the half-year rule as the default first-year fraction. */
function caClass(
  spec: Record<string, [ExactDecimal, string] | [ExactDecimal, string, Partial<PoolClassDef>]>,
): Record<string, PoolClassDef> {
  const out: Record<string, PoolClassDef> = {};
  for (const [code, v] of Object.entries(spec)) {
    const [rate, name, over = {}] = v;
    out[code] = {
      code,
      rate,
      method: over.method ?? "declining",
      firstYearFraction: over.firstYearFraction ?? 0.5, // half-year rule
      allowRecapture: over.allowRecapture ?? true,
      allowTerminalLoss: over.allowTerminalLoss ?? true,
      costCap: over.costCap,
      name,
    };
  }
  return out;
}

export function resolvePoolClass(regime: string, code: string): PoolClassDef | null {
  return TAX_DEPRECIATION_REGIMES[regime]?.classes[code] ?? null;
}

export interface MacrsYearInput {
  basis: string;
  placedInServiceOn: string;
  taxYear: number;
  recoveryPeriodYears: ExactDecimal;
  method: "200_db" | "150_db" | "straight_line";
  convention: "half_year" | "mid_quarter" | "mid_month";
  disposedOn?: string | null;
  section179?: string;
  bonusPercent?: ExactDecimal;
  businessUsePercent?: ExactDecimal;
}

export interface MacrsYearResult {
  section179: string;
  bonus: string;
  macrs: string;
  allowance: string;
  remainingBasis: string;
}

/**
 * Compute one calendar tax year for an asset under MACRS without relying on a
 * hard-coded percentage table. DB methods switch to straight line when that
 * produces an equal or larger deduction; the applicable averaging convention
 * determines the first/disposal/final-year fraction.
 */
export function computeMacrsYear(input: MacrsYearInput): MacrsYearResult {
  const placed = parseIsoDate(input.placedInServiceOn);
  const disposed = input.disposedOn ? parseIsoDate(input.disposedOn) : null;
  if (!placed || input.taxYear < placed.year) return zeroMacrs("0");
  if (disposed && input.taxYear > disposed.year) return zeroMacrs("0");

  const percent = (value: ExactDecimal | undefined, fallback: string): string => {
    const normalized = normalizeMoney(value ?? fallback);
    if (cmp(normalized, "0") < 0) return "0.0000";
    return cmp(normalized, "100") > 0 ? "100.0000" : normalized;
  };
  const originalBasis = mulPercent(normalizeMoney(input.basis), percent(input.businessUsePercent, "100"));
  const section179Cap = minMoney(originalBasis, nonnegative(normalizeMoney(input.section179 ?? "0")));
  const elected179 = placed.year === input.taxYear ? section179Cap : "0.0000";
  const after179 = add(originalBasis, neg(section179Cap));
  const bonus = placed.year === input.taxYear ? mulPercent(after179, percent(input.bonusPercent, "0")) : "0.0000";
  const macrsBasis = add(after179, neg(mulPercent(after179, percent(input.bonusPercent, "0"))));

  const schedule = macrsSchedule({
    basis: macrsBasis,
    placed,
    disposed,
    recoveryPeriodYears: input.recoveryPeriodYears,
    method: input.method,
    convention: input.convention,
  });
  const macrs = schedule.get(input.taxYear) ?? "0.0000";
  const priorMacrs = sum([...schedule.entries()].filter(([year]) => year <= input.taxYear).map(([, amount]) => amount));
  const used179 = input.taxYear >= placed.year ? section179Cap : "0.0000";
  const usedBonus = input.taxYear >= placed.year ? mulPercent(after179, percent(input.bonusPercent, "0")) : "0.0000";
  return {
    section179: formatMoney(elected179, 2), bonus: formatMoney(bonus, 2), macrs: formatMoney(macrs, 2),
    allowance: formatMoney(sum([elected179, bonus, macrs]), 2),
    remainingBasis: disposed?.year === input.taxYear
      ? "0.00"
      : formatMoney(nonnegative(sum([originalBasis, neg(used179), neg(usedBonus), neg(priorMacrs)])), 2),
  };
}

function macrsSchedule(args: {
  basis: string;
  placed: { year: number; month: number };
  disposed: { year: number; month: number } | null;
  recoveryPeriodYears: ExactDecimal;
  method: "200_db" | "150_db" | "straight_line";
  convention: "half_year" | "mid_quarter" | "mid_month";
}): Map<number, string> {
  const out = new Map<number, string>();
  let remaining = toUnits(args.basis);
  const originalBasis = remaining;
  const recoveryPeriods = exactPeriods(args.recoveryPeriodYears);
  let elapsedPeriods = 0n;
  const first = conventionFraction(args.convention, args.placed.month, "placed");
  const yearsAfterPlacement = (recoveryPeriods - first + 23n) / 24n;
  const lastRecoveryYear = args.placed.year + Number(yearsAfterPlacement);
  const lastYear = args.disposed ? Math.min(lastRecoveryYear, args.disposed.year) : lastRecoveryYear;
  const factorNumerator = args.method === "200_db" ? 2n : args.method === "150_db" ? 3n : 1n;
  const factorDenominator = args.method === "150_db" ? 2n : 1n;

  for (let year = args.placed.year; year <= lastYear && remaining > 0n; year++) {
    let fraction = year === args.placed.year ? first : year === lastRecoveryYear ? maxBigInt(0n, recoveryPeriods - elapsedPeriods) : 24n;
    if (args.disposed?.year === year) fraction = minBigInt(fraction, conventionFraction(args.convention, args.disposed.month, "disposed"));
    const lifeRemaining = maxBigInt(1n, recoveryPeriods - elapsedPeriods);
    const straight = args.method === "straight_line"
      ? { numerator: originalBasis * 24n, denominator: recoveryPeriods }
      : { numerator: remaining * 24n, denominator: lifeRemaining };
    const declining = {
      numerator: remaining * factorNumerator * 24n,
      denominator: factorDenominator * recoveryPeriods,
    };
    const annual = args.method === "straight_line" || compareRational(straight, declining) >= 0 ? straight : declining;
    const amount = minBigInt(remaining, roundDiv(annual.numerator * fraction, annual.denominator * 24n));
    out.set(year, fromUnits(amount));
    remaining -= amount;
    elapsedPeriods += fraction;
  }
  return out;
}

/**
 * Half-months of the tax year in service under a MACRS convention.
 *
 * The definition is shared with the book engine (depreciation-conventions.ts),
 * which derives its own monthly window from the same table. Restating it here
 * is what let the two engines disagree about `half_year` in the first place.
 */
const conventionFraction = taxConventionHalfMonths;

function parseIsoDate(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

function zeroMacrs(basis: string): MacrsYearResult {
  return { section179: "0.00", bonus: "0.00", macrs: "0.00", allowance: "0.00", remainingBasis: formatMoney(basis, 2) };
}

function exactPeriods(years: ExactDecimal): bigint {
  const periods = toUnits(String(years)) * 24n;
  if (periods <= 0n || periods % 10_000n !== 0n) throw new Error("recovery period must resolve to complete half-month periods");
  return periods / 10_000n;
}

function exactRatio(numerator: bigint, denominator: bigint, divisor: ExactDecimal): string {
  const divisorUnits = toUnits(String(divisor));
  if (divisorUnits <= 0n) throw new Error("ratio divisor must be positive");
  const scale = 10_000_000_000n;
  const units = roundDiv(numerator * scale * 10_000n, denominator * divisorUnits);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(10, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function compareRational(left: { numerator: bigint; denominator: bigint }, right: { numerator: bigint; denominator: bigint }): number {
  const delta = left.numerator * right.denominator - right.numerator * left.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

const minBigInt = (left: bigint, right: bigint) => left < right ? left : right;
const maxBigInt = (left: bigint, right: bigint) => left > right ? left : right;

export interface PoolYearInput {
  /** Opening written-down value of the pool (decimal string). */
  openingBalance: string;
  additions: string;
  dispositions: string;
  rate: ExactDecimal;
  /** Fraction of net additions in the year-1 base (1 = full, 0.5 = half-year). Default 1. */
  firstYearFraction?: ExactDecimal;
  /** Enhanced first-year multiplier (> 1 suspends the fraction and boosts the
   *  base by (m−1)×net additions — e.g. Canada AII). From dated config. */
  enhancedFirstYearMultiplier?: ExactDecimal;
  /** Immediate-expensing amount fully deducted before the rate (decimal string). */
  immediateExpense?: string;
  /** Short fiscal year proration = days/365. Default 1. */
  shortYearFactor?: ExactDecimal;
  /** True if the pool still holds assets at year-end (governs terminal loss). */
  poolHasAssetsAtYearEnd?: boolean;
  /** Discretionary cap on the allowance claimed (decimal string). Default: max. */
  claimCap?: string;
  allowRecapture?: boolean;
  allowTerminalLoss?: boolean;
}

export interface PoolYearResult {
  openingBalance: string;
  additions: string;
  dispositions: string;
  netAdditions: string;
  immediateExpense: string;
  base: string;
  allowance: string;
  closingBalance: string;
  /** Income when the pool goes negative (recapture / balancing charge). */
  recapture: string;
  /** Deduction when the pool empties with value left (terminal loss / balancing allowance). */
  terminalLoss: string;
}

const zeroMoney = "0.0000";
const nonnegative = (value: string) => cmp(value, zeroMoney) < 0 ? zeroMoney : value;
const minMoney = (left: string, right: string) => cmp(left, right) <= 0 ? left : right;
const s = (value: string) => formatMoney(value, 2);

/** Persist pool opening balance through exact decimal then ledger money. Fail closed. */
function persistPoolOpeningBalance(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("opening balance must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("opening balance must be an exact decimal");
  }
}

/** Persist pool additions through exact decimal then ledger money. Fail closed. */
function persistPoolAdditions(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("additions must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("additions must be an exact decimal");
  }
}

/** Persist pool dispositions through exact decimal then ledger money. Fail closed. */
function persistPoolDispositions(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("dispositions must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("dispositions must be an exact decimal");
  }
}

export function computePoolYear(input: PoolYearInput): PoolYearResult {
  const opening = persistPoolOpeningBalance(input.openingBalance);
  const additions = persistPoolAdditions(input.additions);
  const dispositions = persistPoolDispositions(input.dispositions);
  const requestedImmediateExpense = nonnegative(normalizeMoney(input.immediateExpense ?? "0"));
  const shortYear = String(input.shortYearFactor ?? 1);
  const firstYearFraction = String(input.firstYearFraction ?? 1);
  const netAdditions = nonnegative(add(additions, neg(dispositions)));
  const balance = roundMoney(add(add(opening, additions), neg(dispositions)), 2);

  const zero = (over: Partial<PoolYearResult>): PoolYearResult => ({
    openingBalance: s(opening), additions: s(additions), dispositions: s(dispositions),
    netAdditions: s(netAdditions), immediateExpense: "0.00", base: "0.00",
    allowance: "0.00", closingBalance: "0.00", recapture: "0.00", terminalLoss: "0.00", ...over,
  });

  if (cmp(balance, zeroMoney) < 0 && (input.allowRecapture ?? true)) return zero({ recapture: s(neg(balance)) });
  if (cmp(balance, zeroMoney) > 0 && input.poolHasAssetsAtYearEnd === false && (input.allowTerminalLoss ?? true)) {
    return zero({ terminalLoss: s(balance) });
  }
  if (cmp(balance, zeroMoney) <= 0) return zero({ closingBalance: "0.00" });

  const immediateExpense = minMoney(requestedImmediateExpense, balance);
  const afterIei = add(balance, neg(immediateExpense));
  let base: string;
  const enhancedMultiplier = String(input.enhancedFirstYearMultiplier ?? 1);
  if (cmp(normalizeMoney(enhancedMultiplier), "1") > 0) {
    const enhancedAddition = add(mulDecimal(netAdditions, enhancedMultiplier), neg(netAdditions));
    base = add(afterIei, enhancedAddition);
  } else {
    const eligibleAddition = mulDecimal(netAdditions, firstYearFraction);
    base = add(afterIei, neg(add(netAdditions, neg(eligibleAddition))));
  }
  base = nonnegative(roundMoney(base, 2));

  let allowance = roundMoney(mulDecimalFactors(base, [String(input.rate), shortYear]), 2);
  allowance = minMoney(nonnegative(allowance), roundMoney(afterIei, 2));
  if (input.claimCap != null) allowance = minMoney(allowance, nonnegative(normalizeMoney(input.claimCap)));

  return zero({
    immediateExpense: s(immediateExpense),
    base: s(base),
    allowance: s(allowance),
    closingBalance: s(roundMoney(add(afterIei, neg(allowance)), 2)),
  });
}
