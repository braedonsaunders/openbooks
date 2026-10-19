/**
 * Scenario models read from the recorded book: the pro-forma round and the
 * exit waterfall, both on the cap table as it stands on the model date.
 * SAFEs and notes take part on the terms in force on that date (an MFN
 * election's adopted terms included); an instrument stated in another
 * currency is restated into the legal entity's functional currency at the
 * model date's rate, which the caller resolves.
 */
import {
  buildCapTable,
  capitalizationCounts,
  conversionPrice,
  conversionRatio,
  convertibleState,
  holdingState,
  originalIssuePrice,
  vestingTermsOf,
} from "./cap-table.ts";
import { convertingAmount, type ConvertingInstrument } from "./convertibles.ts";
import { EquityError } from "./errors.ts";
import { restate } from "./fx.ts";
import { addRational, compareRational, divideRational, formatMoney, multiplyRational, parseDecimal, parseMoney, parsePrice, PERCENT_SCALE, rational, subtractRational, type Rational } from "./quantities.ts";
import { modelRound, type ProtectedClass, type RoundModelResult } from "./round-model.ts";
import { restatePrice } from "./splits.ts";
import type { EquityBook, SecurityRecord, ShareClassRecord } from "./types.ts";
import { acceleratedVested, hasVestingSchedule } from "./vesting.ts";
import { piecewiseCurve } from "./waterfall-curve.ts";
import { runWaterfall, type WaterfallAward, type WaterfallClass, type WaterfallConvertible, type WaterfallInput, type WaterfallResult } from "./waterfall.ts";

export interface RoundScenario {
  asOf: string;
  preMoneyValuation: string;
  investment: string;
  targetPoolPercent: string | null;
}

/** Units of the functional currency per unit of each instrument currency on the model date. */
export type ModelRates = ReadonlyMap<string, string>;

/** Currencies of the SAFEs and notes outstanding on the model date (the rates a model needs). */
export function modelCurrencies(book: EquityBook, asOf: string): string[] {
  return [...new Set(book.securities
    .filter((security) => (security.kind === "safe" || security.kind === "note") && security.issueDate <= asOf)
    .filter((security) => convertibleState(book, security, asOf).status === "outstanding")
    .map((security) => security.currency))];
}

/** Outstanding SAFEs and notes on the model date, with the amounts that would convert, in the functional currency. */
function outstandingConvertibles(book: EquityBook, asOf: string, rates: ModelRates): { instrument: ConvertingInstrument; holderPartyId: string }[] {
  return book.securities
    .filter((security) => (security.kind === "safe" || security.kind === "note") && security.issueDate <= asOf)
    .map((security) => ({ security, state: convertibleState(book, security, asOf) }))
    .filter(({ state }) => state.status === "outstanding")
    .map(({ security, state }) => {
      const rate = rates.get(security.currency);
      if (rate === undefined) {
        throw new EquityError(`No ${security.currency} rate was resolved for ${security.securityNumber}.`, { code: "equity_fx_rate_missing", remedy: "Record the exchange rate for the model date (Setup → Exchange Rates)." });
      }
      const terms = state.terms;
      return {
        instrument: {
          terms,
          amount: restate(convertingAmount(terms, asOf), rate),
          cap: terms.valuationCap ? restate(parseMoney(terms.valuationCap, "the valuation cap"), rate) : null,
        },
        holderPartyId: security.holderPartyId,
      };
    });
}

/** Model a priced round against the book as of the scenario date. */
export function modelRoundFromBook(book: EquityBook, scenario: RoundScenario, rates: ModelRates): RoundModelResult {
  const table = buildCapTable(book, scenario.asOf);
  const counts = capitalizationCounts(table);
  const convertibles = outstandingConvertibles(book, scenario.asOf, rates);
  const protectedClasses: ProtectedClass[] = book.classes
    .filter((shareClass) => shareClass.kind === "preferred" && shareClass.antiDilution !== "none" && shareClass.effectiveOn <= scenario.asOf)
    .map((shareClass) => ({
      shareClassId: shareClass.id,
      code: shareClass.code,
      method: shareClass.antiDilution,
      conversionPrice: conversionPrice(book, shareClass, scenario.asOf)!,
      originalIssuePrice: originalIssuePrice(book, shareClass, scenario.asOf)!,
      outstandingShares: BigInt(table.classes.find((row) => row.shareClassId === shareClass.id)?.outstanding ?? "0"),
    }))
    .filter((entry) => entry.outstandingShares > 0n);
  return modelRound({
    preMoneyValuation: scenario.preMoneyValuation,
    investment: scenario.investment,
    targetPoolPercent: scenario.targetPoolPercent,
    fullyDilutedBefore: counts.fullyDiluted,
    outstandingBefore: counts.asConvertedOutstanding,
    poolAvailableBefore: counts.poolAvailable,
    convertibles: convertibles.map((entry) => entry.instrument),
    convertibleHolders: new Map(convertibles.map((entry) => [entry.instrument.terms.id, entry.holderPartyId])),
    protectedClasses,
    holdersBefore: counts.byHolder,
  });
}

export interface ExitScenario {
  asOf: string;
  exitValue: string;
  /** Transaction fees and expenses paid from the exit value before any holder (none when absent). */
  transactionFees?: string | null;
  /** Unvested awards take part, or only vested units (after any acceleration) do. */
  unvestedAwards: "participate" | "cancel";
  changeOfControl: boolean;
  terminated: boolean;
  minorUnitScale: number;
}

/**
 * A certificate's preference price per share on `asOf`, before the
 * liquidation multiple, for a class that measures its preference on the
 * amount paid: what was paid per share issued (the purchase price, or the
 * amount a SAFE or note converted), restated through the class's splits and
 * into the functional currency at the certificate's issue rate. Null for a
 * class measured on its original issue price, or a certificate that records
 * no amount paid, which then takes the class's original issue price.
 */
export function preferencePrice(book: Pick<EquityBook, "splits">, shareClass: ShareClassRecord, security: SecurityRecord, asOf: string): Rational | null {
  if (shareClass.kind !== "preferred" || shareClass.liquidationPreferenceBasis !== "amount_paid") return null;
  let paid: Rational | null = null;
  if (security.considerationAmount && security.quantity !== null && security.quantity > 0n) {
    paid = divideRational(parseMoney(security.considerationAmount, "the amount paid"), rational(security.quantity));
  } else if (security.pricePerShare) {
    paid = parsePrice(security.pricePerShare, "the price per share");
  }
  if (!paid) return null;
  return restate(restatePrice(book.splits, shareClass.id, paid, security.issueDate, asOf), security.fxRate);
}

/** The holders, awards and convertibles taking part in an exit as of the scenario date. */
function waterfallParticipants(book: EquityBook, scenario: Omit<ExitScenario, "exitValue" | "minorUnitScale">, rates: ModelRates): Pick<WaterfallInput, "classes" | "awards" | "convertibles"> {
  const { asOf } = scenario;
  const classes: WaterfallClass[] = [];
  const holdingsByClass = new Map<string, { securityId: string; holderPartyId: string; shares: bigint; preferencePrice: Rational | null }[]>();
  const classById = new Map(book.classes.map((row) => [row.id, row]));
  const awards: WaterfallAward[] = [];
  for (const security of book.securities) {
    if (security.issueDate > asOf || security.quantity === null || !security.shareClassId) continue;
    const state = holdingState(book, security, asOf);
    if (state.outstanding === 0n) continue;
    if (security.kind === "share") {
      const list = holdingsByClass.get(security.shareClassId) ?? [];
      const shareClass = classById.get(security.shareClassId);
      list.push({
        securityId: security.id, holderPartyId: security.holderPartyId, shares: state.outstanding,
        preferencePrice: shareClass ? preferencePrice(book, shareClass, security, asOf) : null,
      });
      holdingsByClass.set(security.shareClassId, list);
      continue;
    }
    let shares = state.outstanding;
    if (scenario.unvestedAwards === "cancel" && hasVestingSchedule(vestingTermsOf(security))) {
      shares = acceleratedVested(state.vestedAvailable, state.outstanding, security, { changeOfControl: scenario.changeOfControl, terminated: scenario.terminated });
    }
    if (shares === 0n) continue;
    const strike = security.kind === "rsu" || !security.pricePerShare
      ? rational(0n)
      : restatePrice(book.splits, security.shareClassId, parsePrice(security.pricePerShare, "the exercise price"), security.issueDate, asOf);
    awards.push({ securityId: security.id, holderPartyId: security.holderPartyId, shareClassId: security.shareClassId, shares, strike });
  }
  for (const shareClass of book.classes) {
    if (shareClass.effectiveOn > asOf) continue;
    const multiple: Rational = shareClass.liquidationMultiple ? parseDecimal(shareClass.liquidationMultiple, "the liquidation multiple", PERCENT_SCALE) : rational(0n);
    classes.push({
      shareClassId: shareClass.id,
      code: shareClass.code,
      kind: shareClass.kind,
      seniority: shareClass.seniority,
      liquidationMultiple: multiple,
      participation: shareClass.participation,
      participationCapMultiple: shareClass.participationCapMultiple ? parseDecimal(shareClass.participationCapMultiple, "the participation cap", PERCENT_SCALE) : null,
      originalIssuePrice: originalIssuePrice(book, shareClass, asOf),
      conversionRatio: conversionRatio(book, shareClass, asOf),
      holdings: holdingsByClass.get(shareClass.id) ?? [],
    });
  }
  const convertibles: WaterfallConvertible[] = outstandingConvertibles(book, asOf, rates).map(({ instrument, holderPartyId }) => ({
    securityId: instrument.terms.id,
    holderPartyId,
    kind: instrument.terms.kind,
    amount: instrument.amount,
    cap: instrument.terms.kind === "safe" ? instrument.cap ?? null : null,
    postMoney: instrument.terms.kind === "safe" && instrument.terms.safeType === "post_money",
  }));
  return { classes, awards, convertibles };
}

function scenarioMoney(value: string, field: "exitValue" | "transactionFees"): Rational {
  try {
    return parseMoney(value, field === "exitValue" ? "the exit value" : "the transaction fees");
  } catch (error) {
    throw new EquityError(
      field === "exitValue" ? "The exit value must be a decimal amount with at most four places." : "The transaction fees must be a decimal amount with at most four places.",
      { code: "equity_waterfall_invalid", remedy: field === "exitValue" ? "Enter the exit value, such as 25000000." : "Enter the fees paid from the exit, such as 750000, or leave them blank.", field, cause: error },
    );
  }
}

/** The proceeds an exit leaves for holders: the exit value less the transaction fees, which cannot exceed it. */
export function netExitProceeds(exitValue: string, transactionFees: string | null | undefined): Rational {
  const gross = scenarioMoney(exitValue, "exitValue");
  if (!transactionFees) return gross;
  const fees = scenarioMoney(transactionFees, "transactionFees");
  if (compareRational(fees, rational(0n)) < 0) {
    throw new EquityError("The transaction fees cannot be negative.", { code: "equity_waterfall_invalid", remedy: "Enter the fees paid from the exit, or leave them blank.", field: "transactionFees" });
  }
  if (compareRational(fees, gross) > 0) {
    throw new EquityError("The transaction fees exceed the exit value.", { code: "equity_waterfall_invalid", remedy: "Enter fees no greater than the exit value.", field: "transactionFees" });
  }
  return subtractRational(gross, fees);
}

/** Run the exit waterfall against the book as of the scenario date, on the exit value net of transaction fees. */
export function waterfallFromBook(book: EquityBook, scenario: ExitScenario, rates: ModelRates): WaterfallResult {
  const exitValue = netExitProceeds(scenario.exitValue, scenario.transactionFees);
  return runWaterfall({ exitValue, ...waterfallParticipants(book, scenario, rates), minorUnitScale: scenario.minorUnitScale });
}

/**
 * The waterfall across exit values from zero to `span` times the scenario's
 * exit value, the same fees taken from each (an exit below the fees leaves
 * nothing): how each class's proceeds move with the exit, and where
 * preferred classes switch between preference and conversion. The curve
 * holds `points` evenly spaced exits plus a point beside every bend of a
 * payout, located to within one unit of currency, so straight lines between
 * its points draw every payout exactly.
 */
export function waterfallCurveFromBook(book: EquityBook, scenario: ExitScenario, rates: ModelRates, points: number, span: Rational): { exitValue: string; result: WaterfallResult }[] {
  const gross = scenarioMoney(scenario.exitValue, "exitValue");
  netExitProceeds(scenario.exitValue, scenario.transactionFees);
  const fees = scenario.transactionFees ? scenarioMoney(scenario.transactionFees, "transactionFees") : rational(0n);
  const participants = waterfallParticipants(book, scenario, rates);
  const minorUnit = rational(1n, 10n ** BigInt(Math.max(0, scenario.minorUnitScale)));
  const curve = piecewiseCurve<WaterfallResult>({
    from: rational(0n),
    to: multiplyRational(gross, span),
    points,
    resolution: rational(1n),
    evaluate: (exit) => runWaterfall({ exitValue: compareRational(exit, fees) > 0 ? subtractRational(exit, fees) : rational(0n), ...participants, minorUnitScale: scenario.minorUnitScale }),
    measures: curveMeasures,
    // Each payout line rounds to the minor unit on its own, so a series may
    // drift from a straight line by up to one minor unit per line.
    tolerance: (result) => multiplyRational(minorUnit, rational(BigInt(result.payouts.length + result.classes.length + 1))),
  });
  return curve.map((point) => ({ exitValue: formatMoney(point.exit), result: point.result }));
}

/** The payout series a waterfall curve draws: each class, awards, SAFEs, notes and the unallocated remainder. */
function curveMeasures(result: WaterfallResult): Map<string, Rational> {
  const measures = new Map<string, Rational>();
  const add = (key: string, amount: string) => measures.set(key, addRational(measures.get(key) ?? rational(0n), parseMoney(amount, "the payout")));
  for (const row of result.classes) add(`class:${row.shareClassId}`, row.total);
  for (const payout of result.payouts) if (payout.kind !== "share") add(`kind:${payout.kind}`, payout.amount);
  add("unallocated", result.unallocated);
  return measures;
}
