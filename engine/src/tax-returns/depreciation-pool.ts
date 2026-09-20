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

import { add, cmp, formatMoney, fromUnits, mulDecimal, mulDecimalFactors, mulPercent, mulRatio, neg, normalizeMoney, roundDiv, roundMoney, sum, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { taxConventionHalfMonths } from "../assets/depreciation-conventions.ts";
import {
  MacrsShortYearError,
  assertShortYearFactorAgrees,
  decliningBalanceRate,
  deemedPlacedInServiceOn,
  formatCalendarDay,
  impliedShortYearFactor,
  isShortTaxYear,
  monthsTreatedInService,
  remainingAfter,
  shortTaxYearMonths,
  shortYearPlacementDeduction,
  subsequentRecoveryDeduction,
} from "./macrs-short-year.ts";

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
  shortYearFactor?: ExactDecimal;
  shortYearMethod?: "simplified" | "allocation";
  shortYearMonths?: number;
  /** Inclusive statutory year window. Required for a short year. */
  yearStart?: string;
  yearEnd?: string;
  /** True when a prior recovery year was short — tables no longer apply. */
  afterShortYear?: boolean;
  /** Beginning-of-year adjusted basis after a short year (simplified method). */
  adjustedBasisAtYearStart?: string;
  /** Frozen deemed placed-in-service date from the short year. */
  deemedPlacedOn?: string;
  /** Months treated as in service during the short year (Aug–Dec = 5). */
  firstYearMonthsInService?: number;
  /** True only for the tax year immediately after the first short year. */
  allocationFollowYear?: boolean;
  /** Recovery months already treated as in service before this tax year. */
  elapsedRecoveryMonths?: number;
  /** 0-based service year of THIS vintage. Fiscal windows are not calendar years. */
  recoveryYearIndex?: number;
  /** Declared transferor adjusted basis — buyer opening/closing checkpoint. */
  adjustedCarryover?: string;
  /** Transfer date that starts the carryover checkpoint (pre-transfer years are history only). */
  carryoverOn?: string;
  /**
   * Taxable MACRS dispositions (default when disposedOn is set) are Pub 946
   * excepted property if placed and disposed in the same tax-year window.
   * Nontaxable step-in-shoes transfers keep convention continuity.
   */
  dispositionRecognition?: "taxable" | "nontaxable" | null;
}

export interface MacrsYearResult {
  section179: string;
  bonus: string;
  macrs: string;
  allowance: string;
  remainingBasis: string;
}

/** Persist MACRS basis through exact decimal then ledger money. Fail closed. */
function persistMacrsBasis(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("basis must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("basis must be an exact decimal");
  }
}

/** Persist MACRS section 179 through exact decimal then ledger money. Fail closed. */
function persistMacrsSection179(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("section179 must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("section179 must be an exact decimal");
  }
}

/** Persist MACRS business-use percent through exact decimal then ledger money. Fail closed. */
function persistMacrsBusinessUsePercent(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("businessUsePercent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("businessUsePercent must be an exact decimal");
  }
}

/** Persist MACRS bonus percent through exact decimal then ledger money. Fail closed. */
function persistMacrsBonusPercent(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("bonusPercent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("bonusPercent must be an exact decimal");
  }
}

/**
 * Pub 946 Excepted Property: property placed and taxably disposed in the same
 * tax year is not depreciable. A fiscal window, not equal YYYY, is the tax year
 * when yearStart/yearEnd are supplied. Nontaxable step-in-shoes transfers are
 * not this exception — they keep convention continuity.
 */
export function placedAndDisposedInSameTaxYear(args: {
  placedInServiceOn: string;
  disposedOn: string;
  yearStart?: string;
  yearEnd?: string;
  taxYear?: number;
}): boolean {
  if (args.yearStart && args.yearEnd) {
    return (
      args.placedInServiceOn >= args.yearStart &&
      args.placedInServiceOn <= args.yearEnd &&
      args.disposedOn >= args.yearStart &&
      args.disposedOn <= args.yearEnd
    );
  }
  const placed = parseIsoDate(args.placedInServiceOn);
  const disposed = parseIsoDate(args.disposedOn);
  if (!placed || !disposed) return false;
  if (args.taxYear != null) return placed.year === args.taxYear && disposed.year === args.taxYear;
  return placed.year === disposed.year;
}

function disposedInTaxYear(input: MacrsYearInput, disposed: { year: number; month: number } | null): boolean {
  if (!input.disposedOn || !disposed) return false;
  if (input.yearStart && input.yearEnd) {
    return input.disposedOn >= input.yearStart && input.disposedOn <= input.yearEnd;
  }
  return disposed.year === input.taxYear;
}

function notYetPlacedInTaxYear(input: MacrsYearInput, placed: { year: number; month: number } | null): boolean {
  if (input.yearEnd && input.placedInServiceOn > input.yearEnd) return true;
  if (!placed) return true;
  if (input.yearStart && input.yearEnd) return false;
  return input.taxYear < placed.year;
}

/**
 * Compute one calendar tax year for an asset under MACRS without relying on a
 * hard-coded percentage table. DB methods switch to straight line when that
 * produces an equal or larger deduction; the applicable averaging convention
 * determines the first/disposal/final-year fraction.
 */
export function computeMacrsYear(input: MacrsYearInput): MacrsYearResult {
  // Bonus and business-use elections are percentages of basis: out-of-range
  // values previously computed silently (bonus 200% deducted twice the basis,
  // negative values wrote negative lines), so fail closed first — ahead of
  // the date early-returns below, or an invalid election would be silently
  // accepted on a pre-placement/disposed branch.
  const businessUsePercent = persistMacrsBusinessUsePercent(input.businessUsePercent ?? "100");
  if (cmp(businessUsePercent, "0") < 0 || cmp(businessUsePercent, "100") > 0) {
    throw new Error("business use percent must be between 0 and 100");
  }
  const bonusPercent = persistMacrsBonusPercent(input.bonusPercent ?? "0");
  if (cmp(bonusPercent, "0") < 0 || cmp(bonusPercent, "100") > 0) {
    throw new Error("bonus percent must be between 0 and 100");
  }
  const shortYearUnits = factorUnits(input.shortYearFactor ?? 1, "short year factor");
  if (shortYearUnits <= 0n || shortYearUnits > FACTOR_SCALE) {
    throw new Error("short year factor must be greater than 0 and at most 1 (days/365)");
  }
  const shortYearMethod = input.shortYearMethod ?? "simplified";
  if (shortYearMethod !== "simplified" && shortYearMethod !== "allocation") {
    throw new Error("short year method must be simplified or allocation");
  }
  if (input.yearStart && input.yearEnd) {
    try {
      assertShortYearFactorAgrees(input.yearStart, input.yearEnd, input.shortYearFactor);
    } catch (error) {
      throw error instanceof MacrsShortYearError ? new Error(error.message) : error;
    }
  } else if (shortYearUnits !== FACTOR_SCALE) {
    throw new Error(
      "short-year MACRS requires yearStart and yearEnd; do not scale a calendar schedule by a factor or months/12",
    );
  }
  const placed = parseIsoDate(input.placedInServiceOn);
  const disposed = input.disposedOn ? parseIsoDate(input.disposedOn) : null;
  if (notYetPlacedInTaxYear(input, placed)) return zeroMacrs(persistMacrsBasis(input.basis));
  if (input.yearStart && input.disposedOn && input.disposedOn < input.yearStart) return zeroMacrs("0");
  if (!input.yearStart && disposed && input.taxYear > disposed.year) return zeroMacrs("0");
  if (
    input.disposedOn &&
    input.dispositionRecognition !== "nontaxable" &&
    placedAndDisposedInSameTaxYear({
      placedInServiceOn: input.placedInServiceOn,
      disposedOn: input.disposedOn,
      yearStart: input.yearStart,
      yearEnd: input.yearEnd,
      taxYear: input.taxYear,
    })
  ) {
    return {
      section179: "0.00",
      bonus: "0.00",
      macrs: "0.00",
      allowance: "0.00",
      remainingBasis: "0.00",
    };
  }
  if (!placed) return zeroMacrs(persistMacrsBasis(input.basis));
  const originalBasis = mulPercent(persistMacrsBasis(input.basis), businessUsePercent);
  const section179Cap = minMoney(originalBasis, nonnegative(persistMacrsSection179(input.section179 ?? "0")));
  const firstYear = input.yearStart && input.yearEnd
    ? input.placedInServiceOn >= input.yearStart && input.placedInServiceOn <= input.yearEnd
    : placed.year === input.taxYear;
  const elected179 = firstYear ? section179Cap : "0.0000";
  const after179 = add(originalBasis, neg(section179Cap));
  const bonus = firstYear ? mulPercent(after179, bonusPercent) : "0.0000";
  const macrsBasis = add(after179, neg(mulPercent(after179, bonusPercent)));

  if (
    input.yearStart &&
    input.yearEnd &&
    (input.afterShortYear || isShortTaxYear(input.yearStart, input.yearEnd))
  ) {
    return computeMacrsPub946Year({
      ...input,
      yearStart: input.yearStart,
      yearEnd: input.yearEnd,
      originalBasis,
      macrsBasis,
      elected179,
      bonus,
      section179Cap,
      placedYear: placed.year,
    });
  }

  const disposedThisYear = disposedInTaxYear(input, disposed);
  const recoveryYearIndex = input.recoveryYearIndex ?? (
    input.yearStart && input.yearEnd
      && input.placedInServiceOn >= input.yearStart
      && input.placedInServiceOn <= input.yearEnd
      ? 0
      : input.taxYear - placed.year
  );
  const placedMonth = monthInTaxYear(input.placedInServiceOn, input.yearStart);
  const disposedMonth = input.disposedOn ? monthInTaxYear(input.disposedOn, input.yearStart) : null;
  const schedule = macrsSchedule({
    basis: macrsBasis,
    placedMonth,
    disposedRecoveryYear: disposedThisYear ? recoveryYearIndex : null,
    disposedMonth,
    recoveryPeriodYears: input.recoveryPeriodYears,
    method: input.method,
    convention: input.convention,
  });
  let macrs = schedule.get(recoveryYearIndex) ?? "0.0000";
  const priorBeforeThisYear = sum(
    [...schedule.entries()].filter(([year]) => year < recoveryYearIndex).map(([, amount]) => amount),
  );
  const used179 = firstYear || recoveryYearIndex > 0 ? section179Cap : "0.0000";
  const usedBonus = firstYear || recoveryYearIndex > 0 ? mulPercent(after179, bonusPercent) : "0.0000";
  return {
    section179: formatMoney(elected179, 2), bonus: formatMoney(bonus, 2), macrs: formatMoney(macrs, 2),
    allowance: formatMoney(sum([elected179, bonus, macrs]), 2),
    remainingBasis: disposedThisYear
      ? "0.00"
      : formatMoney(nonnegative(sum([originalBasis, neg(used179), neg(usedBonus), neg(priorBeforeThisYear), neg(macrs)])), 2),
  };
}

function computeMacrsPub946Year(input: MacrsYearInput & {
  yearStart: string;
  yearEnd: string;
  originalBasis: string;
  macrsBasis: string;
  elected179: string;
  bonus: string;
  section179Cap: string;
  placedYear: number;
}): MacrsYearResult {
  const rate = decliningBalanceRate(input.method, String(input.recoveryPeriodYears));
  const disposedThisYear = !!input.disposedOn && input.disposedOn >= input.yearStart && input.disposedOn <= input.yearEnd;
  if (input.afterShortYear) {
    const opening = persistMacrsBasis(input.adjustedBasisAtYearStart ?? input.macrsBasis);
    const months = shortTaxYearMonths(input.yearStart, input.yearEnd);
    let serviceMonths = months;
    if (disposedThisYear && input.disposedOn) {
      const deemedEnd = deemedPlacedInServiceOn(input.convention, input.yearStart, input.yearEnd, input.disposedOn);
      const held = monthsTreatedInService(deemedEnd, input.yearEnd);
      serviceMonths = Math.max(0, months - held);
    }
    if ((input.shortYearMethod ?? "simplified") === "allocation" && input.firstYearMonthsInService == null && input.elapsedRecoveryMonths == null) {
      throw new Error(
        "allocation MACRS after a short year requires the short year's months treated as in service",
      );
    }
    const macrs = subsequentRecoveryDeduction({
      method: input.method,
      recoveryPeriodYears: String(input.recoveryPeriodYears),
      originalMacrsBasis: input.macrsBasis,
      adjustedBasis: opening,
      elapsedMonths: input.elapsedRecoveryMonths ?? input.firstYearMonthsInService ?? 0,
      monthsThisYear: serviceMonths,
      shortYearMethod: input.shortYearMethod ?? "simplified",
    });
    const remaining = disposedThisYear ? "0.00" : remainingAfter(opening, macrs);
    return {
      section179: "0.00",
      bonus: "0.00",
      macrs: formatMoney(macrs, 2),
      allowance: formatMoney(macrs, 2),
      remainingBasis: remaining,
    };
  }
  const deemed = deemedPlacedInServiceOn(input.convention, input.yearStart, input.yearEnd, input.placedInServiceOn);
  let months = monthsTreatedInService(deemed, input.yearEnd);
  if (disposedThisYear && input.disposedOn && input.dispositionRecognition === "nontaxable") {
    const deemedEnd = deemedPlacedInServiceOn(input.convention, input.yearStart, input.yearEnd, input.disposedOn);
    months = Math.min(months, Math.max(0, monthsTreatedInService(deemed, input.yearEnd) - monthsTreatedInService(deemedEnd, input.yearEnd)));
  }
  const macrs = shortYearPlacementDeduction({ basis: input.macrsBasis, rate, monthsInService: months });
  const used179 = input.taxYear >= input.placedYear ? input.section179Cap : "0.0000";
  const usedBonus = input.taxYear >= input.placedYear ? input.bonus : "0.0000";
  return {
    section179: formatMoney(input.elected179, 2),
    bonus: formatMoney(input.bonus, 2),
    macrs: formatMoney(macrs, 2),
    allowance: formatMoney(sum([input.elected179, input.bonus, macrs]), 2),
    remainingBasis: disposedThisYear
      ? "0.00"
      : formatMoney(nonnegative(sum([input.originalBasis, neg(used179), neg(usedBonus), neg(macrs)])), 2),
  };
}

export interface MacrsYearWindow {
  taxYear: number;
  yearStart: string;
  yearEnd: string;
}

/** Walk statutory windows so a later partial disposal cannot reprice a prior opening.
 *  Windows track THIS vintage's service — a subsidiary short year before placement
 *  is not this asset's first short year. */
export function computeMacrsThroughYear(
  input: MacrsYearInput,
  windows: MacrsYearWindow[],
): {
  current: MacrsYearResult;
  prior: MacrsYearResult;
  deemedPlacedOn: string | null;
  firstYearMonthsInService: number | null;
  allocationFollowYear: boolean;
  currentRecoveryYearIndex: number | null;
} {
  const ordered = [...windows].sort((left, right) => left.taxYear - right.taxYear);
  const checkpoint = input.adjustedCarryover ? persistMacrsBasis(input.adjustedCarryover) : null;
  const carryoverOn = input.carryoverOn ?? null;
  let vintageShortSeen = false;
  let yearsSinceVintageShort = 0;
  let deemedPlacedOn: string | null = null;
  let firstYearMonthsInService: number | null = null;
  let elapsedRecoveryMonths = 0;
  let allocationFollowYear = false;
  let serviceYears = 0;
  let postTransferTaken = "0";
  let adjusted = persistMacrsBasis(input.basis);
  let prior = zeroMacrs(checkpoint ?? adjusted);
  let current = zeroMacrs(checkpoint ?? adjusted);
  let currentRecoveryYearIndex: number | null = null;
  for (const window of ordered) {
    if (window.taxYear > input.taxYear) break;
    if (input.placedInServiceOn > window.yearEnd) continue;
    if (input.disposedOn && input.disposedOn < window.yearStart) continue;
    const firstServiceYear = serviceYears === 0;
    if (vintageShortSeen) yearsSinceVintageShort += 1;
    const short = isShortTaxYear(window.yearStart, window.yearEnd);
    const afterShortYear = vintageShortSeen || (short && !firstServiceYear);
    const followYear = yearsSinceVintageShort === 1;
    const preTransfer = !!(checkpoint && carryoverOn && window.yearEnd < carryoverOn);
    const windowFactor = impliedShortYearFactor(window.yearStart, window.yearEnd);
    const openingCheckpoint = checkpoint && !preTransfer
      ? persistMacrsBasis(add(checkpoint, neg(postTransferTaken)))
      : undefined;
    const result = computeMacrsYear({
      ...input,
      taxYear: window.taxYear,
      yearStart: window.yearStart,
      yearEnd: window.yearEnd,
      recoveryYearIndex: serviceYears,
      afterShortYear,
      allocationFollowYear: followYear,
      firstYearMonthsInService: firstYearMonthsInService ?? undefined,
      elapsedRecoveryMonths,
      adjustedBasisAtYearStart: afterShortYear ? (openingCheckpoint ?? adjusted) : undefined,
      deemedPlacedOn: deemedPlacedOn ?? undefined,
      shortYearFactor: window.taxYear === input.taxYear ? input.shortYearFactor : windowFactor,
      disposedOn: input.disposedOn,
      dispositionRecognition: input.dispositionRecognition,
    });
    if (firstServiceYear && short) {
      deemedPlacedOn = formatCalendarDay(
        deemedPlacedInServiceOn(input.convention, window.yearStart, window.yearEnd, input.placedInServiceOn),
      );
      firstYearMonthsInService = monthsTreatedInService(
        {
          year: Number(deemedPlacedOn.slice(0, 4)),
          month: Number(deemedPlacedOn.slice(5, 7)),
          day: Number(deemedPlacedOn.slice(8, 10)),
        },
        window.yearEnd,
      );
      elapsedRecoveryMonths = firstYearMonthsInService;
      vintageShortSeen = true;
      yearsSinceVintageShort = 0;
    } else if (short && !firstServiceYear) {
      vintageShortSeen = true;
      elapsedRecoveryMonths += shortTaxYearMonths(window.yearStart, window.yearEnd);
    } else if (vintageShortSeen) {
      elapsedRecoveryMonths += short ? shortTaxYearMonths(window.yearStart, window.yearEnd) : 12;
    } else {
      elapsedRecoveryMonths += firstServiceYear
        ? Number(taxConventionHalfMonths(input.convention, monthInTaxYear(input.placedInServiceOn, window.yearStart), "placed")) / 2
        : 12;
    }
    if (preTransfer) {
      if (window.taxYear === input.taxYear - 1) prior = { ...zeroMacrs(checkpoint!), remainingBasis: checkpoint! };
      if (window.taxYear === input.taxYear) {
        current = { ...zeroMacrs(checkpoint!), remainingBasis: checkpoint! };
        allocationFollowYear = followYear;
        currentRecoveryYearIndex = serviceYears;
      }
      serviceYears += 1;
      continue;
    }
    let applied = result;
    if (checkpoint) {
      const opening = persistMacrsBasis(add(checkpoint, neg(postTransferTaken)));
      const take = firstServiceYear ? result.allowance : result.macrs;
      const remaining = input.disposedOn
        && input.disposedOn >= window.yearStart
        && input.disposedOn <= window.yearEnd
        ? "0.00"
        : remainingAfter(opening, take);
      applied = {
        section179: firstServiceYear ? result.section179 : "0.00",
        bonus: firstServiceYear ? result.bonus : "0.00",
        macrs: result.macrs,
        allowance: firstServiceYear ? result.allowance : result.macrs,
        remainingBasis: remaining,
      };
      postTransferTaken = formatMoney(add(postTransferTaken, take), 2);
    }
    adjusted = persistMacrsBasis(applied.remainingBasis);
    if (window.taxYear === input.taxYear - 1) prior = applied;
    if (window.taxYear === input.taxYear) {
      current = applied;
      allocationFollowYear = followYear;
      currentRecoveryYearIndex = serviceYears;
    }
    serviceYears += 1;
  }
  return { current, prior, deemedPlacedOn, firstYearMonthsInService, allocationFollowYear, currentRecoveryYearIndex };
}

function monthInTaxYear(date: string, yearStart?: string): number {
  const day = parseIsoDate(date);
  if (!day) return 1;
  if (!yearStart) return day.month;
  const start = parseIsoDate(yearStart);
  if (!start) return day.month;
  return Math.min(12, Math.max(1, (day.year - start.year) * 12 + (day.month - start.month) + 1));
}

function macrsSchedule(args: {
  basis: string;
  placedMonth: number;
  disposedRecoveryYear: number | null;
  disposedMonth: number | null;
  recoveryPeriodYears: ExactDecimal;
  method: "200_db" | "150_db" | "straight_line";
  convention: "half_year" | "mid_quarter" | "mid_month";
}): Map<number, string> {
  const out = new Map<number, string>();
  let remaining = toUnits(args.basis);
  const originalBasis = remaining;
  const recoveryPeriods = exactPeriods(args.recoveryPeriodYears);
  let elapsedPeriods = 0n;
  const first = conventionFraction(args.convention, args.placedMonth, "placed");
  const yearsAfterPlacement = (recoveryPeriods - first + 23n) / 24n;
  const lastRecoveryYear = Number(yearsAfterPlacement);
  const factorNumerator = args.method === "200_db" ? 2n : args.method === "150_db" ? 3n : 1n;
  const factorDenominator = args.method === "150_db" ? 2n : 1n;

  for (let year = 0; year <= lastRecoveryYear && remaining > 0n; year++) {
    let fraction = year === 0 ? first : year === lastRecoveryYear ? maxBigInt(0n, recoveryPeriods - elapsedPeriods) : 24n;
    if (args.disposedRecoveryYear === year && args.disposedMonth != null) {
      fraction = minBigInt(fraction, conventionFraction(args.convention, args.disposedMonth, "disposed"));
    }
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
  /** Fraction of net additions in the year-1 base (1 = full, 0.5 = half-year). Default 1. Enforced to [0, 1]. */
  firstYearFraction?: ExactDecimal;
  /** Enhanced first-year multiplier (> 1 suspends the fraction and boosts the
   *  base by (m−1)×net additions — e.g. Canada AII). From dated config. */
  enhancedFirstYearMultiplier?: ExactDecimal;
  /** Immediate-expensing amount fully deducted before the rate (decimal string). */
  immediateExpense?: string;
  /** Short fiscal year proration = days/365. Default 1. Enforced to (0, 1]. */
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

/** Persist pool immediate expense through exact decimal then ledger money. Fail closed. */
function persistPoolImmediateExpense(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("immediate expense must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("immediate expense must be an exact decimal");
  }
}

/** Persist pool claim cap through exact decimal then ledger money. Fail closed. */
function persistPoolClaimCap(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("claim cap must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("claim cap must be an exact decimal");
  }
}

/** Persist pool enhanced first-year multiplier through exact decimal then ledger money. Fail closed. */
function persistPoolEnhancedMultiplier(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("enhanced first-year multiplier must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("enhanced first-year multiplier must be an exact decimal");
  }
}

/** Factor-math domain (up to 10dp): range-check one factor through the shared
 *  exact-decimal parser rather than a local duplicate of its semantics. */
const FACTOR_SCALE = 10_000_000_000n;
function factorUnits(value: ExactDecimal, label: string): bigint {
  const canonical = canonicalDecimal(value, 10);
  if (canonical === null) {
    const raw = String(value ?? "").trim();
    const fraction = raw.includes(".") ? raw.split(".")[1] ?? "" : "";
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && fraction.length > 10) {
      throw new Error(`${label} loses precision beyond 10 decimal places`);
    }
    throw new Error(`${label} must be an exact decimal`);
  }
  const negative = canonical.startsWith("-");
  const [whole = "0", fraction = ""] = canonical.replace(/^[+-]/, "").split(".");
  const units = BigInt(whole || "0") * FACTOR_SCALE + BigInt((fraction + "0".repeat(10)).slice(0, 10));
  return negative ? -units : units;
}

export function computePoolYear(input: PoolYearInput): PoolYearResult {
  const opening = persistPoolOpeningBalance(input.openingBalance);
  const additions = persistPoolAdditions(input.additions);
  const dispositions = persistPoolDispositions(input.dispositions);
  const requestedImmediateExpense = nonnegative(persistPoolImmediateExpense(input.immediateExpense ?? "0"));
  // Out-of-domain scaling knobs previously computed silently: a short-year
  // factor of 2 doubled the allowance, a negative one (or rate) claimed
  // nothing, and a first-year fraction above 1 deducted more than the
  // statutory rate allows. All three arrive from tenant configuration
  // (pool classes, first-year rules, run options), so fail closed here —
  // the one boundary every caller crosses — instead of posting the misstatement.
  if (factorUnits(input.rate, "rate") < 0n) throw new Error("rate cannot be negative");
  const shortYearUnits = factorUnits(input.shortYearFactor ?? 1, "short year factor");
  if (shortYearUnits <= 0n || shortYearUnits > FACTOR_SCALE) {
    throw new Error("short year factor must be greater than 0 and at most 1 (days/365)");
  }
  const firstYearUnits = factorUnits(input.firstYearFraction ?? 1, "first year fraction");
  if (firstYearUnits < 0n || firstYearUnits > FACTOR_SCALE) {
    throw new Error("first year fraction must be between 0 and 1");
  }
  // The claim cap is validated here — ahead of the recapture/terminal/zero
  // early-returns below — so a negative cap cannot slip through on another
  // branch. It is applied to the allowance at the end, unchanged.
  let claimCap: string | null = null;
  if (input.claimCap != null) {
    claimCap = persistPoolClaimCap(input.claimCap);
    if (cmp(claimCap, zeroMoney) < 0) throw new Error("claim cap cannot be negative");
  }
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
  const enhancedMultiplier = persistPoolEnhancedMultiplier(input.enhancedFirstYearMultiplier ?? 1);
  if (cmp(enhancedMultiplier, "1") > 0) {
    const enhancedAddition = add(mulDecimal(netAdditions, enhancedMultiplier), neg(netAdditions));
    base = add(afterIei, enhancedAddition);
  } else {
    const eligibleAddition = mulDecimal(netAdditions, firstYearFraction);
    base = add(afterIei, neg(add(netAdditions, neg(eligibleAddition))));
  }
  base = nonnegative(roundMoney(base, 2));

  let allowance = roundMoney(mulDecimalFactors(base, [String(input.rate), shortYear]), 2);
  allowance = minMoney(nonnegative(allowance), roundMoney(afterIei, 2));
  // A negative cap used to coerce to zero and silently disallow the whole
  // claim; it is refused at the top instead, and the validated cap applies here.
  if (claimCap !== null) allowance = minMoney(allowance, claimCap);

  return zero({
    immediateExpense: s(immediateExpense),
    base: s(base),
    allowance: s(allowance),
    closingBalance: s(roundMoney(add(afterIei, neg(allowance)), 2)),
  });
}
