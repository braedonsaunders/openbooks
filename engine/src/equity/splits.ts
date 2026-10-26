/**
 * Stock splits restate share counts and per-share prices as of a date.
 *
 * A split effective on date E applies to quantities stated before E: a
 * security issued, an event dated, a reserve change or an authorized-share
 * amendment recorded on E is already stated in post-split terms. A quantity
 * is restated through every later split at once and rounded down to whole
 * shares once (fractional shares are settled in cash, never issued); a
 * per-share price is divided by the same factor.
 */
import { equityError, fig } from "./errors.ts";
import {
  divideRational,
  floorShares,
  multiplyRational,
  ONE,
  rational,
  type Rational,
} from "./quantities.ts";
import type { SplitRecord } from "./types.ts";

/** Product of the ratios of a class's splits effective after `after` and on or before `through`. */
export function splitFactor(
  splits: readonly SplitRecord[],
  shareClassId: string,
  after: string,
  through: string,
): Rational {
  let factor = ONE;
  for (const split of splits) {
    if (split.shareClassId !== shareClassId) continue;
    if (split.effectiveOn > after && split.effectiveOn <= through) {
      factor = multiplyRational(factor, rational(split.ratioNumerator, split.ratioDenominator));
    }
  }
  return factor;
}

/** A whole-share quantity stated on `statedOn`, restated to `asOf`. */
export function restateShares(
  splits: readonly SplitRecord[],
  shareClassId: string,
  quantity: bigint,
  statedOn: string,
  asOf: string,
): bigint {
  return floorShares(
    multiplyRational(rational(quantity), splitFactor(splits, shareClassId, statedOn, asOf)),
  );
}

/** A per-share price stated on `statedOn`, restated to `asOf` (exact; the caller quantizes). */
export function restatePrice(
  splits: readonly SplitRecord[],
  shareClassId: string,
  price: Rational,
  statedOn: string,
  asOf: string,
): Rational {
  return divideRational(price, splitFactor(splits, shareClassId, statedOn, asOf));
}

/** Refuse a split ratio the schema would refuse, before anything is written. */
export function validateSplitRatio(numerator: bigint, denominator: bigint): void {
  if (numerator <= 0n || denominator <= 0n || numerator === denominator) {
    throw equityError(
      "splitRatioInvalid",
      { newShares: fig.term("splitNew"), oldShares: fig.term("splitOld") },
      { field: "ratio" },
    );
  }
}
