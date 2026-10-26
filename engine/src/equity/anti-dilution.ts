/**
 * Price-based anti-dilution protection of a preferred class.
 *
 * When new shares are sold below the class's conversion price, the price
 * is lowered:
 *  - full ratchet: to the new issue price;
 *  - weighted average: CP2 = CP1 × (A + B) / (A + C), where A is the shares
 *    deemed outstanding before the issue, B the shares the new money would
 *    have bought at CP1, and C the shares actually issued. Broad-based counts
 *    A on a fully diluted basis (outstanding shares as converted, outstanding
 *    awards and the unallocated pool); narrow-based counts outstanding shares
 *    as converted only.
 * A sale at or above the conversion price changes nothing. The new price is
 * rounded half up to ten decimal places, the stored scale.
 */
import { equityError } from "./errors.ts";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  PRICE_SCALE,
  quantize,
  rational,
  type Rational,
} from "./quantities.ts";
import type { AntiDilution } from "./types.ts";

export interface AntiDilutionInputs {
  method: AntiDilution;
  conversionPrice: Rational;
  newIssuePrice: Rational;
  newMoney: Rational;
  /** Shares issued in the new round (exact). */
  newShares: Rational;
  fullyDilutedBefore: bigint;
  outstandingBefore: bigint;
}

/** The adjusted conversion price (exact), or the unchanged price when no adjustment applies. */
export function adjustedConversionPriceExact(inputs: AntiDilutionInputs): Rational {
  const { method, conversionPrice, newIssuePrice } = inputs;
  if (method === "none" || compareRational(newIssuePrice, conversionPrice) >= 0)
    return conversionPrice;
  if (method === "full_ratchet") return newIssuePrice;
  const base = rational(
    method === "broad_based" ? inputs.fullyDilutedBefore : inputs.outstandingBefore,
  );
  if (base.numerator <= 0n) {
    throw equityError("antiDilutionBaseMissing");
  }
  const wouldHaveBought = divideRational(inputs.newMoney, conversionPrice);
  return multiplyRational(
    conversionPrice,
    divideRational(addRational(base, wouldHaveBought), addRational(base, inputs.newShares)),
  );
}

/** The adjusted conversion price as the stored ten-place decimal (half up). */
export function adjustedConversionPrice(inputs: AntiDilutionInputs): Rational {
  const units = quantize(adjustedConversionPriceExact(inputs), PRICE_SCALE, "half_up");
  return rational(units, 10n ** BigInt(PRICE_SCALE));
}
