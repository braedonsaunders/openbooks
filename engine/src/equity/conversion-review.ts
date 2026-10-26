/**
 * Review a recorded conversion against the terms that stand. A historical
 * snapshot resolves which MFN terms priced it when later backdated activity
 * has changed both possible prices. Posted conversions remain immutable;
 * the review directs governed corrections without inferring provenance from
 * whichever current price happens to be nearer.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { conversionOnVoidedTerms, effectiveConvertibleTerms, eventsOf } from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { spotRate } from "./fx.ts";
import { currencyExponent } from "./internal.ts";
import { formatPrice, parsePrice } from "./quantities.ts";
import { conversionAtRound, roundInstruments, type RoundPricing } from "./round-conversion.ts";
import { loadEquityBookAtEvent } from "./store.ts";
import type { EquityBook, SecurityRecord } from "./types.ts";

/** A conversion whose recorded price no longer agrees with the round's measurement of the terms that priced it. */
export interface ConversionDrift {
  securityId: string;
  roundId: string;
  convertedOn: string;
  resultingSecurityId: string | null;
  recordedPrice: string;
  standingPrice: string;
  recordedShares: string;
  standingShares: string;
}

export interface ConversionReview {
  /** The conversion relied on terms adopted from a void instrument and is corrected by converting again. */
  voidedTerms: ReturnType<typeof conversionOnVoidedTerms>;
  /** The conversion stands on its own terms, but the round now measures them at another price. */
  drift: ConversionDrift | null;
}

/** Exchange rates and minor units of every currency converting in a round, on its closing date. */
export async function roundPricing(
  runner: SqlExecutor,
  orgId: string,
  book: EquityBook,
  roundId: string,
  functional: string,
): Promise<RoundPricing> {
  const round = book.rounds.find((row) => row.id === roundId)!;
  const rates = new Map<string, string>();
  const exponents = new Map<string, number>();
  for (const instrument of roundInstruments(book, roundId)) {
    if (rates.has(instrument.currency)) continue;
    rates.set(
      instrument.currency,
      await spotRate(
        runner,
        orgId,
        instrument.currency,
        round.currency,
        round.closedOn,
        functional,
      ),
    );
    exponents.set(instrument.currency, await currencyExponent(runner, instrument.currency));
  }
  return { rates, exponents };
}

/** The review of a convertible's conversion on `asOf`; null when it has not converted at a round, or nothing calls for review. */
export async function reviewRecordedConversion(
  runner: SqlExecutor,
  orgId: string,
  book: EquityBook,
  security: SecurityRecord,
  asOf: string,
  functional: string,
  pricingCache?: Map<string, RoundPricing>,
  recordedBook?: EquityBook,
): Promise<ConversionReview | null> {
  if (security.kind !== "safe" && security.kind !== "note") return null;
  const flagged = conversionOnVoidedTerms(book, security, asOf);
  const conversion = eventsOf(book, security.id, asOf).find((event) => event.kind === "convert");
  const round = conversion?.roundId
    ? book.rounds.find((row) => row.id === conversion.roundId)
    : undefined;
  if (!conversion || !round || !conversion.pricePerShare)
    return flagged ? { voidedTerms: flagged, drift: null } : null;
  const recorded = parsePrice(conversion.pricePerShare, "conversionPrice");
  let pricing = pricingCache?.get(round.id);
  let standing;
  try {
    if (!pricing) {
      pricing = await roundPricing(runner, orgId, book, round.id, functional);
      pricingCache?.set(round.id, pricing);
    }
    standing = conversionAtRound(book, security, round.id, pricing);
  } catch (error) {
    if (!(error instanceof EquityError)) throw error;
    return flagged ? { voidedTerms: flagged, drift: null } : null;
  }
  if (flagged) {
    // A current price match cannot establish provenance: later activity can
    // move the standing price to a price once given by different terms.
    try {
      const historical =
        recordedBook ?? (await loadEquityBookAtEvent(runner, orgId, conversion.id));
      const original = historical?.securities.find((row) => row.id === security.id);
      if (!historical || !original) return { voidedTerms: flagged, drift: null };
      const originalPricing = await roundPricing(runner, orgId, historical, round.id, functional);
      const originalConversion = conversionAtRound(historical, original, round.id, originalPricing);
      const terms = effectiveConvertibleTerms(historical, original, conversion.effectiveOn);
      if (
        formatPrice(recorded) !== formatPrice(originalConversion.price) ||
        terms.electionId === flagged.electionId
      )
        return { voidedTerms: flagged, drift: null };
    } catch (error) {
      if (!(error instanceof EquityError)) throw error;
      return { voidedTerms: flagged, drift: null };
    }
  }
  // Prices are stored to ten decimal places. A recomputed rational can carry
  // recurring digits beyond that precision without changing the recorded price.
  if (formatPrice(recorded) === formatPrice(standing.price)) return null;
  const certificate = conversion.resultingSecurityId
    ? book.securities.find((row) => row.id === conversion.resultingSecurityId)
    : undefined;
  return {
    voidedTerms: null,
    drift: {
      securityId: security.id,
      roundId: round.id,
      convertedOn: conversion.effectiveOn,
      resultingSecurityId: conversion.resultingSecurityId,
      recordedPrice: formatPrice(recorded),
      standingPrice: formatPrice(standing.price),
      recordedShares: (certificate?.quantity ?? conversion.quantity ?? 0n).toString(),
      standingShares: standing.shares.toString(),
    },
  };
}

/** Every recorded conversion into a round that has drifted from the round's current measurement. */
export async function roundConversionDrift(
  runner: SqlExecutor,
  orgId: string,
  book: EquityBook,
  roundId: string,
  asOf: string,
  functional: string,
  pricingCache?: Map<string, RoundPricing>,
): Promise<ConversionDrift[]> {
  const out: ConversionDrift[] = [];
  for (const security of book.securities) {
    if (security.kind !== "safe" && security.kind !== "note") continue;
    const conversion = eventsOf(book, security.id, asOf).find((event) => event.kind === "convert");
    if (conversion?.roundId !== roundId) continue;
    const review = await reviewRecordedConversion(
      runner,
      orgId,
      book,
      security,
      asOf,
      functional,
      pricingCache,
    );
    if (review?.drift) out.push(review.drift);
  }
  return out;
}
