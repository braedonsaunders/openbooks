/**
 * SAFEs and convertible notes: the amount that converts, the price it
 * converts at, and the shares it becomes at a priced round.
 *
 * - A SAFE converts its purchase amount. A note converts principal plus
 *   interest accrued to the conversion date on its own day count and
 *   compounding (see interest.ts).
 * - An MFN SAFE converts on the terms its holder adopted from a later
 *   instrument, from the election date (see mfn.ts).
 * - The conversion price is the lowest of the round price, the cap price
 *   and the discounted round price. A pre-money SAFE (and a note) divides its
 *   cap by the pre-round fully diluted capitalization; a post-money SAFE
 *   divides by the company capitalization that already includes every
 *   converting instrument's shares, which is solved as an exact fixed point.
 * - The recorded conversion price is rounded half up to ten decimal places
 *   and the shares are the converted amount divided by that recorded price,
 *   rounded down, so every conversion is reproducible from its stored row.
 */
import { equityError, fig } from "./errors.ts";
import { noteInterest } from "./interest.ts";
import {
  addRational,
  compareRational,
  divideRational,
  floorShares,
  minRational,
  multiplyRational,
  ONE,
  parseMoney,
  parsePercent,
  PRICE_SCALE,
  quantize,
  rational,
  subtractRational,
  sumRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import type { DayCount, InterestBasis, SafeType, SecurityKind } from "./types.ts";

/** Converting post-money claims at or above this share of the company have no meaningful solution. */
export const MAX_POST_MONEY_CLAIM: Rational = rational(95n, 100n);

export interface ConvertibleTerms {
  id: string;
  kind: Extract<SecurityKind, "safe" | "note">;
  issueDate: string;
  principal: string;
  safeType: SafeType | null;
  valuationCap: string | null;
  discountPercent: string | null;
  interestRatePercent: string | null;
  interestBasis: InterestBasis | null;
  interestDayCount: DayCount | null;
  /** The currency the principal, cap and interest are stated in. */
  currency: string;
}

/** Interest accrued on a note from its issue date to `asOf` (exact). Zero for a SAFE. */
export function accruedInterest(terms: ConvertibleTerms, asOf: string): Rational {
  if (terms.kind !== "note") return ZERO;
  return noteInterest(terms, asOf);
}

/** The amount that converts on `asOf`: purchase amount, or principal plus accrued interest. */
export function convertingAmount(terms: ConvertibleTerms, asOf: string): Rational {
  return addRational(parseMoney(terms.principal, "principal"), accruedInterest(terms, asOf));
}

export interface ConvertingInstrument {
  terms: ConvertibleTerms;
  /** Amount converting at the round (exact), in the currency the round is priced in. */
  amount: Rational;
  /**
   * The valuation cap restated into the round's pricing currency, when the
   * instrument is stated in another currency (absent: the stated cap).
   */
  cap?: Rational | null;
}

export interface ConversionResult {
  securityId: string;
  amount: Rational;
  /** Recorded conversion price, rounded half up to ten places. */
  price: Rational;
  /** Which term set the price. */
  pricedBy: "round" | "cap" | "discount";
  shares: bigint;
}

const isPostMoney = (terms: ConvertibleTerms): boolean =>
  terms.kind === "safe" && terms.safeType === "post_money";

function capOf(instrument: ConvertingInstrument): Rational | null {
  if (instrument.cap !== undefined) return instrument.cap;
  return instrument.terms.valuationCap
    ? parseMoney(instrument.terms.valuationCap, "valuationCap")
    : null;
}

function discountedPrice(terms: ConvertibleTerms, roundPrice: Rational): Rational | null {
  if (!terms.discountPercent) return null;
  return multiplyRational(
    roundPrice,
    subtractRational(ONE, parsePercent(terms.discountPercent, "discountPercent")),
  );
}

/** Combined ownership the capped post-money SAFEs promise (amount / cap, summed). */
export function postMoneyClaim(instruments: readonly ConvertingInstrument[]): Rational {
  return sumRational(
    instruments
      .filter((instrument) => isPostMoney(instrument.terms) && capOf(instrument))
      .map((instrument) => divideRational(instrument.amount, capOf(instrument)!)),
  );
}

/** The lower of the round price and the discounted price: the price before any cap. */
function uncappedPrice(terms: ConvertibleTerms, roundPrice: Rational): Rational {
  const discounted = discountedPrice(terms, roundPrice);
  return discounted ? minRational(roundPrice, discounted) : roundPrice;
}

/**
 * Solve the company capitalization post-money caps divide by. For a set of
 * binding caps the capitalization is exact:
 *   capitalization = (preRound + fixed-price shares) / (1 − Σ amount/cap).
 * A cap binds when cap / capitalization is at or below the instrument's
 * uncapped price; a binding cap keeps binding as the capitalization grows,
 * so the binding set only grows and the solve settles in at most one pass
 * per instrument. Returns the exact capitalization.
 */
export function companyCapitalization(
  instruments: readonly ConvertingInstrument[],
  roundPrice: Rational,
  preRoundFullyDiluted: bigint,
): Rational {
  const claim = postMoneyClaim(instruments);
  if (compareRational(claim, MAX_POST_MONEY_CLAIM) >= 0) {
    throw equityError("postMoneyOverclaim", {
      limit: fig.percent("95"),
      principal: fig.term("principal"),
      cap: fig.term("valuationCap"),
    });
  }
  const preRound = rational(preRoundFullyDiluted);
  const binding = new Set<string>();
  for (let pass = 0; pass <= instruments.length + 1; pass += 1) {
    let fixed = ZERO;
    let bindingClaim = ZERO;
    for (const instrument of instruments) {
      const cap = capOf(instrument);
      if (isPostMoney(instrument.terms) && cap && binding.has(instrument.terms.id)) {
        bindingClaim = addRational(bindingClaim, divideRational(instrument.amount, cap));
      } else {
        fixed = addRational(
          fixed,
          divideRational(instrument.amount, preRoundPrice(instrument, roundPrice, preRound)),
        );
      }
    }
    const capitalization = divideRational(
      addRational(preRound, fixed),
      subtractRational(ONE, bindingClaim),
    );
    let grew = false;
    for (const instrument of instruments) {
      const cap = capOf(instrument);
      if (!isPostMoney(instrument.terms) || !cap || binding.has(instrument.terms.id)) continue;
      if (
        compareRational(
          divideRational(cap, capitalization),
          uncappedPrice(instrument.terms, roundPrice),
        ) <= 0
      ) {
        binding.add(instrument.terms.id);
        grew = true;
      }
    }
    if (!grew) return capitalization;
  }
  throw equityError("postMoneyUnsettled", { cap: fig.term("valuationCap") });
}

/** Exact (unrounded) shares every instrument converts into at a round price: the capitalization less the pre-round count. */
export function exactConversionShares(
  instruments: readonly ConvertingInstrument[],
  roundPrice: Rational,
  preRoundFullyDiluted: bigint,
): Rational {
  if (instruments.length === 0) return ZERO;
  return subtractRational(
    companyCapitalization(instruments, roundPrice, preRoundFullyDiluted),
    rational(preRoundFullyDiluted),
  );
}

/** Price of an instrument whose cap (if any) divides by the pre-round capitalization or does not bind. */
function preRoundPrice(
  instrument: ConvertingInstrument,
  roundPrice: Rational,
  preRound: Rational,
): Rational {
  const { terms } = instrument;
  const price = uncappedPrice(terms, roundPrice);
  const cap = capOf(instrument);
  if (!cap || isPostMoney(terms) || preRound.numerator === 0n) return price;
  return minRational(price, divideRational(cap, preRound));
}

/** Round a conversion price half up to the stored scale; a price that rounds to zero refuses. */
function recordedPrice(price: Rational): Rational {
  const units = quantize(price, PRICE_SCALE, "half_up");
  if (units <= 0n) {
    throw equityError("conversionPriceZero", {
      cap: fig.term("valuationCap"),
      discount: fig.term("discountPercent"),
    });
  }
  return rational(units, 10n ** BigInt(PRICE_SCALE));
}

/**
 * Convert every instrument at a priced round. `preRoundFullyDiluted` is the
 * fully diluted capitalization before the round and before any conversion.
 */
export function convertAtRound(
  instruments: readonly ConvertingInstrument[],
  roundPrice: Rational,
  preRoundFullyDiluted: bigint,
): { conversions: ConversionResult[]; companyCapitalization: Rational } {
  if (roundPrice.numerator <= 0n) {
    throw equityError("conversionRoundPriceNotPositive");
  }
  const capitalization = companyCapitalization(instruments, roundPrice, preRoundFullyDiluted);
  const preRound = rational(preRoundFullyDiluted);
  const conversions = instruments.map((instrument): ConversionResult => {
    const { terms } = instrument;
    const cap = capOf(instrument);
    const discounted = discountedPrice(terms, roundPrice);
    const capPrice = cap
      ? isPostMoney(terms)
        ? divideRational(cap, capitalization)
        : preRound.numerator > 0n
          ? divideRational(cap, preRound)
          : null
      : null;
    let exact = roundPrice;
    let pricedBy: ConversionResult["pricedBy"] = "round";
    if (discounted && compareRational(discounted, exact) < 0) {
      exact = discounted;
      pricedBy = "discount";
    }
    if (capPrice && compareRational(capPrice, exact) < 0) {
      exact = capPrice;
      pricedBy = "cap";
    }
    const price = recordedPrice(exact);
    return {
      securityId: terms.id,
      amount: instrument.amount,
      price,
      pricedBy,
      shares: floorShares(divideRational(instrument.amount, price)),
    };
  });
  return { conversions, companyCapitalization: capitalization };
}
