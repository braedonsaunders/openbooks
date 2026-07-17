/**
 * Canadian Capital Cost Allowance (CCA) — the tax-book depreciation engine.
 *
 * Unlike per-asset book depreciation (monthly, straight-line/declining, posts
 * GL), CCA is a CLASS-POOL declining balance on UCC (Undepreciated Capital
 * Cost), computed ANNUALLY, and is discretionary (claim anywhere from 0 to the
 * maximum). This module is the pure per-class, per-year calculation; the DB pool
 * tables + orchestration wrap it, exactly as the formula engine's core does.
 *
 * The annual waterfall (CRA T2125 / Schedule 8 logic):
 *   1. UCC(open) + additions − dispositions(lesser of proceeds & cost)
 *   2. if that balance < 0  → RECAPTURE (income), UCC(close)=0, no CCA
 *   3. if the class is empty but the balance > 0 → TERMINAL LOSS, UCC(close)=0
 *   4. else CCA base = balance − immediate-expense, adjusted for the half-year
 *      rule OR the Accelerated Investment Incentive; CCA = base × rate × short-
 *      year factor, capped at available UCC and the (optional) discretionary cap
 *   5. UCC(close) = balance − immediate-expense − CCA
 *
 * AII multipliers and immediate-expensing limits are LEGISLATIVELY VOLATILE
 * (2018 AII → 2024 phase-out → Bill C-15 2026 reinstatement), so they are
 * INPUTS here (sourced from a dated config table), never hardcoded.
 */

export interface CcaClassDef {
  cls: string;
  /** Annual rate (declining balance), e.g. 0.20 for Class 8. */
  rate: number;
  method: "declining" | "straight_line";
  /** Classes exempt from the half-year rule (12, 13, 14, …). */
  halfYearExempt?: boolean;
  /** Class 10.1: no recapture on disposal. */
  noRecapture?: boolean;
  /** Class 10.1: no terminal loss on disposal. */
  noTerminalLoss?: boolean;
  /** Per-item capital-cost ceiling (10.1, 54 passenger/ZEV vehicles). */
  costCap?: number;
  name: string;
}

/** Standard CCA classes (2024–2026). Rates verified against CRA class tables;
 *  confirm current AII/immediate-expensing multipliers separately at filing. */
export const CCA_CLASSES: Record<string, CcaClassDef> = {
  "1": { cls: "1", rate: 0.04, method: "declining", name: "Buildings (post-1987)" },
  "3": { cls: "3", rate: 0.05, method: "declining", name: "Buildings (pre-1988)" },
  "8": { cls: "8", rate: 0.20, method: "declining", name: "Furniture, equipment, machinery" },
  "10": { cls: "10", rate: 0.30, method: "declining", name: "Vehicles, general" },
  "10.1": { cls: "10.1", rate: 0.30, method: "declining", noRecapture: true, noTerminalLoss: true, costCap: 37000, name: "Passenger vehicles (over ceiling)" },
  "12": { cls: "12", rate: 1.0, method: "declining", halfYearExempt: true, name: "Tools, software, small items" },
  "13": { cls: "13", rate: 0, method: "straight_line", halfYearExempt: true, name: "Leasehold improvements" },
  "14": { cls: "14", rate: 0, method: "straight_line", halfYearExempt: true, name: "Limited-life intangibles" },
  "14.1": { cls: "14.1", rate: 0.05, method: "declining", name: "Goodwill & unlimited-life intangibles" },
  "16": { cls: "16", rate: 0.40, method: "declining", name: "Taxis, rental vehicles, freight trucks" },
  "43": { cls: "43", rate: 0.30, method: "declining", name: "Manufacturing & processing equipment" },
  "43.1": { cls: "43.1", rate: 0.30, method: "declining", name: "Clean-energy equipment" },
  "43.2": { cls: "43.2", rate: 0.50, method: "declining", name: "Clean-energy equipment (2005–2024)" },
  "50": { cls: "50", rate: 0.55, method: "declining", name: "Computer hardware & systems software" },
  "53": { cls: "53", rate: 0.50, method: "declining", name: "Manufacturing equipment (2016–2025)" },
  "54": { cls: "54", rate: 0.30, method: "declining", costCap: 61000, name: "Zero-emission passenger vehicles" },
  "55": { cls: "55", rate: 0.40, method: "declining", name: "Zero-emission vehicles (Class 16 type)" },
  "56": { cls: "56", rate: 0.30, method: "declining", name: "Zero-emission automotive equipment" },
};

export interface CcaYearInput {
  /** Opening UCC for the class pool (decimal string). */
  uccOpen: string;
  /** Capital cost of additions this year (decimal string). */
  additions: string;
  /** Dispositions = Σ lesser of (proceeds, capital cost) per asset (decimal string). */
  dispositions: string;
  /** Class rate (declining balance). */
  rate: number;
  /** Half-year (50%) rule applies to net additions. Default true; set false for
   *  exempt classes or when AII/immediate-expensing governs the year. */
  halfYearRule?: boolean;
  /** AII enhanced first-year multiplier on net additions (e.g. 1.5, 2, 3). When
   *  > 1 the half-year rule is suspended and the extra (mult−1)×netAdd is added
   *  to the CCA base. From dated config. */
  aiiMultiplier?: number;
  /** Immediate-expensing (IEI/full-expensing) amount fully deducted this year
   *  before the rate applies (decimal string). Already capped by the caller. */
  immediateExpense?: string;
  /** Short fiscal year proration = days/365. Default 1. */
  shortYearFactor?: number;
  /** True if the class still holds assets at year-end (governs terminal loss). */
  classHasAssetsAtYearEnd?: boolean;
  /** Discretionary cap on the CCA claimed this year (decimal string). Default: max. */
  claimCap?: string;
  /** Class 10.1 disposals never recapture. */
  noRecapture?: boolean;
  /** Class 10.1 / 14.1 disposals never trigger a terminal loss. */
  noTerminalLoss?: boolean;
}

export interface CcaYearResult {
  uccOpen: string;
  additions: string;
  dispositions: string;
  /** additions − dispositions, floored at 0 (drives half-year / AII). */
  netAdditions: string;
  immediateExpense: string;
  /** The base the CCA rate is applied to, after half-year/AII/immediate-expense. */
  ccaBase: string;
  ccaClaimed: string;
  uccClose: string;
  /** Income inclusion when the pool goes negative (proceeds exceeded UCC). */
  recapture: string;
  /** Deduction when the class is empty with positive UCC left. */
  terminalLoss: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const s = (n: number) => round2(n).toFixed(2);

export function computeCcaYear(input: CcaYearInput): CcaYearResult {
  const uccOpen = Number(input.uccOpen);
  const additions = Number(input.additions);
  const dispositions = Number(input.dispositions);
  const immediateExpense = Math.max(0, Number(input.immediateExpense ?? "0"));
  const shortYear = input.shortYearFactor ?? 1;
  const netAdditions = Math.max(0, additions - dispositions);

  const balance = round2(uccOpen + additions - dispositions);

  const zero = (over: Partial<CcaYearResult>): CcaYearResult => ({
    uccOpen: s(uccOpen), additions: s(additions), dispositions: s(dispositions),
    netAdditions: s(netAdditions), immediateExpense: "0.00", ccaBase: "0.00",
    ccaClaimed: "0.00", uccClose: "0.00", recapture: "0.00", terminalLoss: "0.00", ...over,
  });

  // Recapture: a negative pool balance is income; the pool resets to zero.
  if (balance < 0 && !input.noRecapture) {
    return zero({ recapture: s(-balance) });
  }
  // Terminal loss: class emptied out but UCC remains → deduct the remainder.
  if (balance > 0 && input.classHasAssetsAtYearEnd === false && !input.noTerminalLoss) {
    return zero({ terminalLoss: s(balance) });
  }
  if (balance <= 0) {
    return zero({ uccClose: s(Math.max(0, balance)) });
  }

  // CCA base after immediate expensing.
  const afterIei = balance - immediateExpense;
  let base: number;
  const halfYear = input.halfYearRule ?? true;
  if (input.aiiMultiplier && input.aiiMultiplier > 1) {
    // AII: half-year suspended; the net addition counts at `multiplier`×.
    base = afterIei + (input.aiiMultiplier - 1) * netAdditions;
  } else if (halfYear) {
    // Half-year rule: only 50% of net additions in the year-1 base.
    base = afterIei - 0.5 * netAdditions;
  } else {
    base = afterIei;
  }
  base = Math.max(0, round2(base));

  let cca = round2(base * input.rate * shortYear);
  // Never claim more than the UCC available after immediate expensing.
  cca = Math.min(cca, round2(afterIei));
  if (input.claimCap != null) cca = Math.min(cca, Math.max(0, Number(input.claimCap)));
  if (cca < 0) cca = 0;

  const uccClose = round2(afterIei - cca);
  return zero({
    immediateExpense: s(immediateExpense),
    ccaBase: s(base),
    ccaClaimed: s(cca),
    uccClose: s(uccClose),
  });
}
