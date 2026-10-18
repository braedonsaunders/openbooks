/**
 * The SAFEs and notes converting at a recorded round, measured the way the
 * conversion posts them.
 *
 * Every instrument outstanding on the round's closing date converts with
 * the others (post-money caps divide by a capitalization that counts every
 * converting instrument's shares). Each converts its principal plus, for a
 * note, the interest accrued to the closing date rounded to its currency's
 * minor unit, which is exactly what the conversion relieves from the ledger.
 * An instrument stated in a currency other than the round's has its amount
 * and cap restated at the closing-date rate. The pre-round capitalization
 * is the fully diluted cap table without the round's own shares and
 * conversions.
 */
import { buildCapTable, convertibleState } from "./cap-table.ts";
import { accruedInterest, convertAtRound, type ConvertingInstrument } from "./convertibles.ts";
import { EquityError } from "./errors.ts";
import { restate } from "./fx.ts";
import { fromLedgerUnits, ledgerUnits, parseMoney, parsePrice, type Rational } from "./quantities.ts";
import type { EquityBook, SecurityRecord } from "./types.ts";

/** The book as it stood before a round: its own investors' shares and its conversions taken out. */
export function bookBeforeRound(book: EquityBook, roundId: string): EquityBook {
  const roundSecurities = new Set(book.securities.filter((row) => row.roundId === roundId).map((row) => row.id));
  return {
    ...book,
    securities: book.securities.filter((row) => !roundSecurities.has(row.id)),
    events: book.events.filter((event) => !(event.resultingSecurityId && roundSecurities.has(event.resultingSecurityId)) && !roundSecurities.has(event.securityId)),
  };
}

/** Instruments outstanding on the round's closing date (before the round), whose currencies the pricing needs. */
export function roundInstruments(book: EquityBook, roundId: string): SecurityRecord[] {
  const round = book.rounds.find((row) => row.id === roundId);
  if (!round) throw new EquityError("The round does not exist for this legal entity.", { status: 404, code: "equity_round_unknown", remedy: "Choose a round of the legal entity.", field: "roundId" });
  const before = bookBeforeRound(book, roundId);
  return before.securities
    .filter((row) => (row.kind === "safe" || row.kind === "note") && row.issueDate <= round.closedOn)
    .filter((row) => convertibleState(before, row, round.closedOn).status === "outstanding");
}

export interface RoundPricing {
  /** Units of the round's currency per unit of each instrument currency on the closing date. */
  rates: ReadonlyMap<string, string>;
  /** Minor-unit exponent of each instrument currency. */
  exponents: ReadonlyMap<string, number>;
}

export interface RoundConversion {
  /** Recorded conversion price in the round's currency. */
  price: Rational;
  shares: bigint;
  /** Amount converting in the instrument's own currency (ledger-exact). */
  amount: Rational;
  pricedBy: "round" | "cap" | "discount";
}

/** Shares a SAFE or note converts into at a round, measured with every instrument converting in it. */
export function conversionAtRound(book: EquityBook, security: SecurityRecord, roundId: string, pricing: RoundPricing): RoundConversion {
  const round = book.rounds.find((row) => row.id === roundId)!;
  const before = bookBeforeRound(book, roundId);
  const table = buildCapTable(before, round.closedOn);
  const instruments = roundInstruments(book, roundId);
  if (!instruments.some((row) => row.id === security.id)) {
    throw new EquityError("The instrument is not outstanding on the round's closing date.", { status: 409, code: "equity_event_invalid", remedy: "Check the instrument's issue date and history." });
  }
  const own = new Map<string, Rational>();
  const converting: ConvertingInstrument[] = instruments.map((row) => {
    const state = convertibleState(before, row, round.closedOn);
    const exponent = pricing.exponents.get(row.currency);
    const rate = pricing.rates.get(row.currency);
    if (exponent === undefined || rate === undefined) {
      throw new EquityError(`No ${row.currency} to ${round.currency} rate was resolved for the conversion.`, { code: "equity_fx_rate_missing", remedy: "Record the exchange rate for the round's closing date (Setup → Exchange Rates)." });
    }
    const principal = ledgerUnits(parseMoney(state.terms.principal, "the principal"), exponent);
    const interest = ledgerUnits(accruedInterest(state.terms, round.closedOn), exponent);
    const amount = fromLedgerUnits(principal + interest);
    own.set(row.id, amount);
    const cap = state.terms.valuationCap ? restate(parseMoney(state.terms.valuationCap, "the valuation cap"), rate) : null;
    return { terms: state.terms, amount: restate(amount, rate), cap };
  });
  const { conversions } = convertAtRound(converting, parsePrice(round.pricePerShare, "the round price"), BigInt(table.totals.fullyDiluted));
  const mine = conversions.find((conversion) => conversion.securityId === security.id)!;
  return { price: mine.price, shares: mine.shares, amount: own.get(security.id)!, pricedBy: mine.pricedBy };
}
