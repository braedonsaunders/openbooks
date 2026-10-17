/**
 * Scenario models read from the recorded book: the pro-forma round and the
 * exit waterfall, both on the cap table as it stands on the model date.
 */
import {
  buildCapTable,
  capitalizationCounts,
  conversionPrice,
  conversionRatio,
  convertibleState,
  convertibleTerms,
  holdingState,
  originalIssuePrice,
  vestingTermsOf,
} from "./cap-table.ts";
import { convertingAmount, type ConvertingInstrument } from "./convertibles.ts";
import { EquityError } from "./errors.ts";
import { parseDecimal, parseMoney, parsePrice, PERCENT_SCALE, rational, type Rational } from "./quantities.ts";
import { modelRound, type ProtectedClass, type RoundModelResult } from "./round-model.ts";
import { restatePrice } from "./splits.ts";
import type { EquityBook } from "./types.ts";
import { acceleratedVested, hasVestingSchedule } from "./vesting.ts";
import { runWaterfall, type WaterfallAward, type WaterfallClass, type WaterfallConvertible, type WaterfallResult } from "./waterfall.ts";

export interface RoundScenario {
  asOf: string;
  preMoneyValuation: string;
  investment: string;
  targetPoolPercent: string | null;
}

/** Outstanding SAFEs and notes on the model date, with the amounts that would convert. */
function outstandingConvertibles(book: EquityBook, asOf: string): { instrument: ConvertingInstrument; holderPartyId: string }[] {
  return book.securities
    .filter((security) => (security.kind === "safe" || security.kind === "note") && security.issueDate <= asOf)
    .filter((security) => convertibleState(book, security, asOf).status === "outstanding")
    .map((security) => {
      const terms = convertibleTerms(security);
      return { instrument: { terms, amount: convertingAmount(terms, asOf) }, holderPartyId: security.holderPartyId };
    });
}

/** Model a priced round against the book as of the scenario date. */
export function modelRoundFromBook(book: EquityBook, scenario: RoundScenario): RoundModelResult {
  const table = buildCapTable(book, scenario.asOf);
  const counts = capitalizationCounts(table);
  const convertibles = outstandingConvertibles(book, scenario.asOf);
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
  /** Unvested awards take part, or only vested units (after any acceleration) do. */
  unvestedAwards: "participate" | "cancel";
  changeOfControl: boolean;
  terminated: boolean;
  minorUnitScale: number;
}

/** Run the exit waterfall against the book as of the scenario date. */
export function waterfallFromBook(book: EquityBook, scenario: ExitScenario): WaterfallResult {
  const { asOf } = scenario;
  const classes: WaterfallClass[] = [];
  const holdingsByClass = new Map<string, { securityId: string; holderPartyId: string; shares: bigint }[]>();
  const awards: WaterfallAward[] = [];
  for (const security of book.securities) {
    if (security.issueDate > asOf || security.quantity === null || !security.shareClassId) continue;
    const state = holdingState(book, security, asOf);
    if (state.outstanding === 0n) continue;
    if (security.kind === "share") {
      const list = holdingsByClass.get(security.shareClassId) ?? [];
      list.push({ securityId: security.id, holderPartyId: security.holderPartyId, shares: state.outstanding });
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
  const convertibles: WaterfallConvertible[] = outstandingConvertibles(book, asOf).map(({ instrument, holderPartyId }) => ({
    securityId: instrument.terms.id,
    holderPartyId,
    kind: instrument.terms.kind,
    amount: instrument.amount,
  }));
  let exitValue: Rational;
  try {
    exitValue = parseMoney(scenario.exitValue, "the exit value");
  } catch (error) {
    throw new EquityError("The exit value must be a decimal amount with at most four places.", { code: "equity_waterfall_invalid", remedy: "Enter the exit value, such as 25000000.", field: "exitValue", cause: error });
  }
  return runWaterfall({ exitValue, classes, awards, convertibles, minorUnitScale: scenario.minorUnitScale });
}
