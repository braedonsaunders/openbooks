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

import { add, cmp, formatMoney, mulDecimal, mulDecimalFactors, neg, normalizeMoney, roundMoney } from "./money.ts";

export interface PoolClassDef {
  /** Regime class code — CA "8"/"10.1", UK "main"/"special". */
  code: string;
  rate: number;
  method: "declining" | "straight_line";
  /** Fraction of net additions eligible in the acquisition year: 1 = full,
   *  0.5 = Canada's half-year rule. */
  firstYearFraction: number;
  /** Disposal can push the pool negative into taxable income (Canada recapture,
   *  UK balancing charge). */
  allowRecapture: boolean;
  /** Emptying the pool with a positive balance yields a deduction (Canada
   *  terminal loss, UK balancing allowance). */
  allowTerminalLoss: boolean;
  /** Per-item capital-cost ceiling (e.g. Canada Class 10.1 / 54 vehicles). */
  costCap?: number;
  name: string;
}

export interface TaxDepreciationRegime {
  code: string;
  name: string;
  classes: Record<string, PoolClassDef>;
}

/** Built-in regimes as data. Add a jurisdiction = add an entry, not code. */
export const TAX_DEPRECIATION_REGIMES: Record<string, TaxDepreciationRegime> = {
  ca_cca: {
    code: "ca_cca",
    name: "Canada — Capital Cost Allowance",
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
    classes: {
      main: fullYear("main", 0.18, "Main rate pool"),
      special: fullYear("special", 0.06, "Special rate pool"),
      sba: { code: "sba", rate: 0.03, method: "straight_line", firstYearFraction: 1, allowRecapture: false, allowTerminalLoss: false, name: "Structures & buildings allowance" },
    },
  },
  au_pool: {
    code: "au_pool",
    name: "Australia — Depreciation Pools",
    classes: {
      // Diminishing-value pools: half the pool rate in the year of allocation.
      sbp: { code: "sbp", rate: 0.3, method: "declining", firstYearFraction: 0.5, allowRecapture: true, allowTerminalLoss: true, name: "Small business pool (15% then 30%)" },
      lvp: { code: "lvp", rate: 0.375, method: "declining", firstYearFraction: 0.5, allowRecapture: true, allowTerminalLoss: true, name: "Low-value pool (18.75% then 37.5%)" },
    },
  },
  nz_pool: {
    code: "nz_pool",
    name: "New Zealand — Pool method",
    classes: {
      // The pool depreciates at the lowest DV rate of its assets; a maintained
      // default the tenant tunes per pool (see Tax Setup → pool classes).
      pool: fullYear("pool", 0.1, "Pooled assets (diminishing value)"),
    },
  },
};

/** A full-year regime class (no half-year rule): first-year fraction 1. */
function fullYear(code: string, rate: number, name: string): PoolClassDef {
  return { code, rate, method: "declining", firstYearFraction: 1, allowRecapture: true, allowTerminalLoss: true, name };
}

/** Build Canada class defs with the half-year rule as the default first-year fraction. */
function caClass(
  spec: Record<string, [number, string] | [number, string, Partial<PoolClassDef>]>,
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

export interface PoolYearInput {
  /** Opening written-down value of the pool (decimal string). */
  openingBalance: string;
  additions: string;
  dispositions: string;
  rate: number;
  /** Fraction of net additions in the year-1 base (1 = full, 0.5 = half-year). Default 1. */
  firstYearFraction?: number;
  /** Enhanced first-year multiplier (> 1 suspends the fraction and boosts the
   *  base by (m−1)×net additions — e.g. Canada AII). From dated config. */
  enhancedFirstYearMultiplier?: number;
  /** Immediate-expensing amount fully deducted before the rate (decimal string). */
  immediateExpense?: string;
  /** Short fiscal year proration = days/365. Default 1. */
  shortYearFactor?: number;
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

export function computePoolYear(input: PoolYearInput): PoolYearResult {
  const opening = normalizeMoney(input.openingBalance);
  const additions = normalizeMoney(input.additions);
  const dispositions = normalizeMoney(input.dispositions);
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
