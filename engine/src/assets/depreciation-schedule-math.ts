/** Pure schedule math: methods, inputs, conventions, formulas. Split from assets/depreciation.ts (ARCH-FILE-SPLIT; pure moves only). */
import { depreciationPeriodCount } from "./depreciation-limits.ts";
import { cmp, fromUnits, mulRatio, toUnits } from "../money/money.ts";
import { BUILTIN_FORMULAS, computeScheduleByFormula, exactRatio } from "./depreciation-formula.ts";
import { bookConventionWindow } from "./depreciation-conventions.ts";
import type { BookDepreciationConvention } from "@openbooks/schema";
import { DepreciationRefusalError } from "./depreciation-errors.ts";

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * The GL accounts a depreciation entry touches. Native asset columns override
 * the category; product behavior never hides in the custom-field JSON blob.
 */
export interface AssetAccounts {
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
}

export function resolveAssetAccounts(
  asset: {
    assetAccountId?: string | null;
    accumulatedDepreciationAccountId?: string | null;
    depreciationExpenseAccountId?: string | null;
  },
  category: {
    assetAccountId: string;
    accumulatedDepreciationAccountId: string;
    depreciationExpenseAccountId: string;
  },
): AssetAccounts {
  return {
    assetAccountId: asset.assetAccountId || category.assetAccountId,
    accumulatedDepreciationAccountId: asset.accumulatedDepreciationAccountId || category.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: asset.depreciationExpenseAccountId || category.depreciationExpenseAccountId,
  };
}

// ---------------------------------------------------------------------------
// Schedule computation (pure)
// ---------------------------------------------------------------------------

export type DepreciationMethod =
  | "straight_line"
  | "declining_balance"
  | "double_declining"
  | "units_of_production"
  | "manual";

export interface ScheduleInput {
  /** acquisition cost, decimal string */
  cost: string;
  /** salvage value, decimal string */
  salvage: string;
  /** YYYY-MM-DD */
  inServiceOn: string;
  /** total useful life in months (> 0) */
  lifeMonths: number;
  method: DepreciationMethod;
  /**
   * Annual rate percent for declining-balance (e.g. "30" = 30%/yr). Ignored for
   * double_declining (rate is derived as 2 / life-years). Defaults, when absent,
   * to the straight-line-equivalent rate (1 / life-years).
   */
  ratePercent?: string | null;
  /**
   * First-period convention: full_month (default), mid_month, or half_year.
   *
   * mid_month halves the first MONTH and extends the schedule by one month;
   * half_year halves the first YEAR — twelve monthly periods — and extends it
   * by six. See conventionFraction.
   */
  convention?: "full_month" | "mid_month" | "half_year" | null;
}

export interface UnitsOfProductionChargeInput {
  cost: string;
  salvage: string;
  lifetimeUnits: string;
  periodUnits: string;
  unitsAlreadyRecorded?: string;
  depreciationAlreadyPlanned: string;
}

/** Exact units-of-production charge, rounded once to ledger precision. Signed
 * usage corrections are capped so accumulated depreciation remains between
 * zero and the depreciable basis. */
export function computeUnitsOfProductionCharge(input: UnitsOfProductionChargeInput): string {
  const basis = toUnits(input.cost) - toUnits(input.salvage);
  const lifetime = toUnits(input.lifetimeUnits);
  const period = toUnits(input.periodUnits);
  const priorUnits = toUnits(input.unitsAlreadyRecorded ?? "0");
  const already = toUnits(input.depreciationAlreadyPlanned);
  if (basis < 0n) throw new DepreciationRefusalError("salvage value cannot exceed acquisition cost");
  if (lifetime <= 0n) throw new DepreciationRefusalError("expected lifetime production units must be greater than zero");
  if (period === 0n) throw new DepreciationRefusalError("period production units must be non-zero");
  if (priorUnits < 0n || priorUnits > lifetime || priorUnits + period < 0n || priorUnits + period > lifetime) {
    throw new DepreciationRefusalError("recorded production must remain between zero and expected lifetime units");
  }
  if (already < 0n || already > basis) throw new DepreciationRefusalError("existing depreciation exceeds the depreciable basis");
  const remaining = basis - already;
  if (priorUnits + period === lifetime) return fromUnits(remaining);
  const magnitude = toUnits(mulRatio(fromUnits(basis), period < 0n ? -period : period, lifetime));
  const proportional = period < 0n ? -magnitude : magnitude;
  if (proportional > remaining) return fromUnits(remaining);
  if (proportional < -already) return fromUnits(-already);
  return fromUnits(proportional);
}

export interface ScheduleLinePlan {
  sequence: number;
  /** YYYY-MM-01 — the calendar month this depreciation belongs to */
  periodMonth: string;
  /** planned depreciation for the month, decimal string (>= 0) */
  planned: string;
  /** accumulated depreciation through and including this month */
  accumulated: string;
  /** net book value at end of month = cost - accumulated */
  netBookValue: string;
}

/** First day of the month for a YYYY-MM-DD date. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
export function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = (y! * 12 + (m! - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * The reduced-charge window for a convention.
 *
 * Delegates to the SHARED definition (engine/src/assets/depreciation-conventions.ts)
 * rather than restating it. This engine and the tax engine used to each decide
 * what `half_year` meant and disagreed: half of one monthly period here, half
 * of a year there. The shared table is now the only place that answer exists.
 */
export function conventionFraction(
  convention: string | null | undefined,
): { firstPeriodFraction: string; firstFractionPeriods: number } {
  return bookConventionWindow(convention as BookDepreciationConvention | null | undefined);
}

/**
 * Compute the monthly depreciation plan for an asset. Every method depreciates
 * from the in-service month forward, one entry per calendar month, and never
 * takes NBV below salvage — the final month absorbs any rounding remainder so
 * total lifetime depreciation is exactly (cost − salvage).
 */
export function computeSchedule(input: ScheduleInput): ScheduleLinePlan[] {
  const life = depreciationPeriodCount(input.lifeMonths);
  const { formula, rateTable } = formulaForMethod(input.method, input.ratePercent, life);
  const { firstPeriodFraction, firstFractionPeriods } = conventionFraction(input.convention);
  const rows = computeScheduleByFormula({
    cost: input.cost,
    salvage: input.salvage,
    lifePeriods: life,
    formula,
    rateTable,
    firstPeriodFraction,
    firstFractionPeriods,
  });
  const start = monthStart(input.inServiceOn);
  return rows.map((r) => ({
    sequence: r.sequence,
    periodMonth: addMonths(start, r.sequence),
    planned: r.planned,
    accumulated: r.accumulated,
    netBookValue: r.netBookValue,
  }));
}

/**
 * Map a built-in method to a formula so the flexible engine drives every method
 * (declining-balance now gets the DB→SL crossover for a clean finish).
 * `declining_balance` passes its exact monthly rate as R1. Manual and
 * units-of-production are input-driven and therefore never reach this
 * formula-only mapper.
 */
function formulaForMethod(
  method: DepreciationMethod,
  ratePercent: string | null | undefined,
  lifeMonths: number,
): { formula: string; rateTable?: string[] } {
  switch (method) {
    case "double_declining":
      return { formula: BUILTIN_FORMULAS.double_declining };
    case "declining_balance": {
      const monthlyRate = ratePercent != null && cmp(ratePercent, "0") > 0
        ? exactRatio(ratePercent, "1200")
        : exactRatio("1", String(lifeMonths));
      return { formula: "(NB-RV)*R1~(NB-RV)/(AL-CP+1)", rateTable: [monthlyRate] };
    }
    case "straight_line":
      return { formula: BUILTIN_FORMULAS.straight_line };
    case "manual":
      throw new DepreciationRefusalError("manual depreciation requires a recorded period amount and evidence");
    case "units_of_production":
      throw new DepreciationRefusalError("units-of-production depreciation requires recorded period usage and lifetime units");
    default: {
      const exhaustive: never = method;
      throw new Error(`unsupported depreciation method ${exhaustive}`);
    }
  }
}
/** Sort helper re-export (kept local so callers don't import money directly). */
export { cmp as compareMoney };
