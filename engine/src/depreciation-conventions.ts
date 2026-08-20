import type {
  BookDepreciationConvention,
  DepreciationConvention,
  TaxDepreciationConvention,
} from "@openbooks/schema";

/**
 * What a first-period convention MEANS — the one definition both depreciation
 * engines derive from.
 *
 * The vocabulary lives in schema/src/depreciation-conventions.ts. This file owns
 * the arithmetic, because the two engines previously each implemented it and
 * disagreed: the tax engine read `half_year` as half of a YEAR (right) while the
 * book engine read it as half of one monthly PERIOD (wrong), and no shared type
 * or constant existed for anything to notice.
 *
 * The engines still differ in shape, and that is correct — the book engine
 * schedules monthly periods from the in-service month, the tax engine allocates
 * within a tax year. What they may not differ on is the FRACTION OF A FULL
 * YEAR a convention allows in year one. For the conventions whose answer is
 * fixed by the rule rather than by the in-service date, that fraction is
 * asserted equal across both engines in depreciation-conventions.test.ts.
 */

const MONTHS_PER_YEAR = 12;

/**
 * How a convention reduces the start of an asset's life, in months.
 *
 * `reducedMonths` is the WIDTH of the reduced window and `reducedFraction` the
 * share of the normal charge taken across it. Conflating those two numbers is
 * exactly the bug this table exists to prevent: mid-month and half-year both
 * take HALF, but over one month and over twelve respectively.
 */
export interface ConventionShape {
  reducedMonths: number;
  /** Share of the normal charge taken in the reduced window. */
  reducedFraction: string;
  /** True when the first-year share depends on WHEN the asset went into
   *  service, so no single fraction can describe it (MACRS mid-month and
   *  mid-quarter place the asset at the middle of its month or quarter). */
  dateDependent: boolean;
}

export const CONVENTION_SHAPES: Record<DepreciationConvention, ConventionShape> = {
  // The whole in-service month counts; nothing is withheld.
  full_month: { reducedMonths: 0, reducedFraction: "1", dateDependent: false },
  // Half of the first MONTH.
  mid_month: { reducedMonths: 1, reducedFraction: "0.5", dateDependent: true },
  // Half of the first QUARTER. Tax engines only — the book engine has no
  // representation for it (see BOOK_DEPRECIATION_CONVENTIONS).
  mid_quarter: { reducedMonths: 3, reducedFraction: "0.5", dateDependent: true },
  // Half of the first YEAR — twelve monthly periods, not one.
  half_year: { reducedMonths: MONTHS_PER_YEAR, reducedFraction: "0.5", dateDependent: false },
};

/**
 * The reduced window in the BOOK engine's terms: how many leading monthly
 * periods to scale, and by how much.
 */
export function bookConventionWindow(
  convention: BookDepreciationConvention | null | undefined,
): { firstPeriodFraction: string; firstFractionPeriods: number } {
  const shape = convention ? CONVENTION_SHAPES[convention] : undefined;
  if (!shape || shape.reducedMonths === 0) {
    return { firstPeriodFraction: "1", firstFractionPeriods: 1 };
  }
  return {
    firstPeriodFraction: shape.reducedFraction,
    firstFractionPeriods: shape.reducedMonths,
  };
}

/**
 * The share of a full year's depreciation a convention allows in year one, as
 * an exact rational. Only meaningful for the date-independent conventions;
 * date-dependent ones return null because the honest answer needs a month.
 *
 * Used by the cross-engine test, and by anything that needs to state the rule
 * without reimplementing it.
 */
export function firstYearFraction(
  convention: DepreciationConvention,
): { numerator: number; denominator: number } | null {
  const shape = CONVENTION_SHAPES[convention];
  if (shape.dateDependent) return null;
  // fraction = 1 − reducedMonths × (1 − reducedFraction) / 12, kept rational so
  // "half a year" is exactly 1/2 rather than a rounded decimal.
  const withheldHalves = shape.reducedFraction === "0.5" ? shape.reducedMonths : 0;
  return {
    numerator: MONTHS_PER_YEAR * 2 - withheldHalves,
    denominator: MONTHS_PER_YEAR * 2,
  };
}

/**
 * Half-months of a twelve-month tax year an asset is in service under a MACRS
 * convention, out of 24. This is the tax engine's native unit: `half_year` is
 * always 12 (six months) regardless of the month, while the mid-month and
 * mid-quarter conventions place the asset at the middle of the month or quarter
 * it was acquired or disposed in.
 */
export function taxConventionHalfMonths(
  convention: TaxDepreciationConvention,
  month: number,
  kind: "placed" | "disposed",
): bigint {
  if (convention === "half_year") return 12n;
  if (convention === "mid_month") {
    return BigInt(kind === "placed" ? 25 - month * 2 : month * 2 - 1);
  }
  const quarter = Math.ceil(month / 3);
  return BigInt(kind === "placed" ? 27 - quarter * 6 : quarter * 6 - 3);
}
