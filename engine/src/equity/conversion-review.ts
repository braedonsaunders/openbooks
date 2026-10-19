/**
 * Whether a recorded SAFE conversion relied on terms adopted from a void
 * instrument, judged by what it recorded.
 *
 * conversionOnVoidedTerms finds a conversion made while an MFN election
 * named a void instrument's terms. Such a conversion may still have been
 * measured on the SAFE's own terms (the void already kept those terms out of
 * the conversion), so the recorded conversion price is compared with the
 * price the round gives on the terms that stand: a conversion recorded at
 * that price stands, any other is flagged for correction. A price that
 * cannot be measured (a missing exchange rate) is flagged, so the
 * conversion is reviewed rather than presumed sound.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { conversionOnVoidedTerms, eventsOf } from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { spotRate } from "./fx.ts";
import { currencyExponent } from "./internal.ts";
import { compareRational, parsePrice } from "./quantities.ts";
import { conversionAtRound, roundInstruments } from "./round-conversion.ts";
import type { EquityBook, SecurityRecord } from "./types.ts";

export async function conversionOnVoidedTermsAsRecorded(
  runner: SqlExecutor,
  orgId: string,
  book: EquityBook,
  security: SecurityRecord,
  asOf: string,
  functional: string,
): Promise<ReturnType<typeof conversionOnVoidedTerms>> {
  const flagged = conversionOnVoidedTerms(book, security, asOf);
  if (!flagged) return null;
  const conversion = eventsOf(book, security.id, asOf).find((event) => event.kind === "convert");
  const round = conversion?.roundId ? book.rounds.find((row) => row.id === conversion.roundId) : undefined;
  if (!conversion?.pricePerShare || !round) return flagged;
  try {
    const rates = new Map<string, string>();
    const exponents = new Map<string, number>();
    for (const instrument of roundInstruments(book, round.id)) {
      if (rates.has(instrument.currency)) continue;
      rates.set(instrument.currency, await spotRate(runner, orgId, instrument.currency, round.currency, round.closedOn, functional));
      exponents.set(instrument.currency, await currencyExponent(runner, instrument.currency));
    }
    const standing = conversionAtRound(book, security, round.id, { rates, exponents });
    return compareRational(standing.price, parsePrice(conversion.pricePerShare, "the conversion price")) === 0 ? null : flagged;
  } catch (error) {
    if (error instanceof EquityError) return flagged;
    throw error;
  }
}
