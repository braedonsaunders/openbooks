/**
 * Pro-forma priced round on the pre-money method.
 *
 * The round price P satisfies P = pre-money / D(P), where the pre-money
 * share count D(P) is the fully diluted count before the round plus every
 * SAFE and note converting at P, plus anti-dilution shares the protected
 * preferred classes gain at P, plus the pool top-up that brings the
 * unallocated pool to its post-round target (the top-up is priced into the
 * pre-money, as term sheets ask). P·D(P) rises strictly with P, so P is
 * found exactly by bisection on the stored ten-place price grid: the
 * largest price whose implied pre-money does not exceed the stated
 * pre-money (the price is rounded down, never up).
 *
 * At the solved price each holding is rounded on its own: investor shares
 * and conversion shares round down (fractions are paid in cash) and the
 * pool top-up rounds up so the target is met. Anti-dilution counts the new
 * money's shares as the shares issued in the round.
 */
import { adjustedConversionPrice, adjustedConversionPriceExact } from "./anti-dilution.ts";
import {
  convertAtRound,
  exactConversionShares,
  type ConversionResult,
  type ConvertingInstrument,
} from "./convertibles.ts";
import { equityError, fig } from "./errors.ts";
import {
  addRational,
  ceilShares,
  compareRational,
  divideRational,
  floorShares,
  formatMoney,
  formatPercent,
  formatPrice,
  multiplyRational,
  ONE,
  parseMoney,
  parsePercent,
  PRICE_SCALE,
  rational,
  subtractRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import type { AntiDilution } from "./types.ts";

export interface ProtectedClass {
  shareClassId: string;
  code: string;
  method: AntiDilution;
  conversionPrice: Rational;
  originalIssuePrice: Rational;
  /** Issued shares of the class outstanding before the round. */
  outstandingShares: bigint;
}

export interface RoundModelInput {
  preMoneyValuation: string;
  investment: string;
  /** Unallocated pool as a percentage of the post-round fully diluted count (null: no top-up). */
  targetPoolPercent: string | null;
  fullyDilutedBefore: bigint;
  outstandingBefore: bigint;
  poolAvailableBefore: bigint;
  convertibles: readonly ConvertingInstrument[];
  convertibleHolders: ReadonlyMap<string, string>;
  protectedClasses: readonly ProtectedClass[];
  /** Fully diluted shares by holder before the round. */
  holdersBefore: ReadonlyMap<string, bigint>;
}

export interface RoundModelDilutionRow {
  key: string;
  kind: "holder" | "new_investors" | "pool" | "anti_dilution";
  sharesBefore: string;
  sharesAfter: string;
  percentBefore: string;
  percentAfter: string;
}

export interface RoundModelResult {
  pricePerShare: string;
  preMoneyValuation: string;
  investment: string;
  postMoneyValuation: string;
  fullyDilutedBefore: string;
  investorShares: string;
  conversionShares: string;
  antiDilutionShares: string;
  poolTopUp: string;
  poolAfter: string;
  fullyDilutedAfter: string;
  investorPercent: string;
  poolPercentAfter: string;
  /** Money the investors pay for fractions they do not receive. */
  investorCashRounding: string;
  conversions: (Omit<ConversionResult, "amount" | "price" | "shares"> & {
    holderPartyId: string | null;
    amount: string;
    price: string;
    shares: string;
  })[];
  antiDilution: {
    shareClassId: string;
    code: string;
    method: AntiDilution;
    previousConversionPrice: string;
    newConversionPrice: string;
    additionalShares: string;
  }[];
  dilution: RoundModelDilutionRow[];
}

const PRICE_UNIT = 10n ** BigInt(PRICE_SCALE);
const priceOf = (units: bigint): Rational => rational(units, PRICE_UNIT);

interface Terms {
  pre: Rational;
  investment: Rational;
  target: Rational;
}

function antiDilutionExact(
  input: RoundModelInput,
  price: Rational,
  newShares: Rational,
  investment: Rational,
): Rational {
  let total = ZERO;
  for (const entry of input.protectedClasses) {
    const adjusted = adjustedConversionPriceExact({
      method: entry.method,
      conversionPrice: entry.conversionPrice,
      newIssuePrice: price,
      newMoney: investment,
      newShares,
      fullyDilutedBefore: input.fullyDilutedBefore,
      outstandingBefore: input.outstandingBefore,
    });
    if (compareRational(adjusted, entry.conversionPrice) >= 0) continue;
    const issueValue = multiplyRational(
      rational(entry.outstandingShares),
      entry.originalIssuePrice,
    );
    total = addRational(
      total,
      subtractRational(
        divideRational(issueValue, adjusted),
        divideRational(issueValue, entry.conversionPrice),
      ),
    );
  }
  return total;
}

function poolTopUpExact(
  input: RoundModelInput,
  target: Rational,
  issuedExceptPool: Rational,
): Rational {
  if (target.numerator === 0n) return ZERO;
  const needed = subtractRational(
    multiplyRational(target, issuedExceptPool),
    rational(input.poolAvailableBefore),
  );
  if (compareRational(needed, ZERO) <= 0) return ZERO;
  return divideRational(needed, subtractRational(ONE, target));
}

/** Implied pre-money at a price: P × D(P). */
function impliedPreMoney(input: RoundModelInput, terms: Terms, price: Rational): Rational {
  const conversion = exactConversionShares(input.convertibles, price, input.fullyDilutedBefore);
  const investor = divideRational(terms.investment, price);
  const adjustment = antiDilutionExact(input, price, investor, terms.investment);
  const beforePool = addRational(
    addRational(rational(input.fullyDilutedBefore), conversion),
    adjustment,
  );
  const pool = poolTopUpExact(input, terms.target, addRational(beforePool, investor));
  return multiplyRational(price, addRational(beforePool, pool));
}

/** Model a priced round. Unsatisfiable terms refuse with the reason. */
export function modelRound(input: RoundModelInput): RoundModelResult {
  const pre = parseMoney(input.preMoneyValuation, "preMoneyValuation");
  const investment = parseMoney(input.investment, "investment");
  const target = input.targetPoolPercent
    ? parsePercent(input.targetPoolPercent, "targetPool")
    : ZERO;
  if (compareRational(pre, ZERO) <= 0) {
    throw equityError("roundPreMoneyNotPositive", {}, { field: "preMoneyValuation" });
  }
  if (compareRational(investment, ZERO) <= 0) {
    throw equityError("roundInvestmentNotPositive", {}, { field: "investment" });
  }
  if (compareRational(target, ZERO) < 0 || compareRational(target, ONE) >= 0) {
    throw equityError(
      "roundTargetPoolOutOfRange",
      { min: fig.percent("0"), max: fig.percent("100") },
      { field: "targetPoolPercent" },
    );
  }
  if (input.fullyDilutedBefore <= 0n) {
    throw equityError("roundNoShares");
  }
  const terms: Terms = { pre, investment, target };
  // Highest candidate: pre-money over the pre-round count alone, rounded up.
  let high = ceilShares(
    multiplyRational(divideRational(pre, rational(input.fullyDilutedBefore)), rational(PRICE_UNIT)),
  );
  let low = 1n;
  if (compareRational(impliedPreMoney(input, terms, priceOf(low)), pre) > 0) {
    throw equityError("roundUnpriceable");
  }
  if (high < low) high = low;
  // Invariant: implied(low) ≤ pre < implied(high + 1).
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (compareRational(impliedPreMoney(input, terms, priceOf(middle)), pre) <= 0) low = middle;
    else high = middle - 1n;
  }
  const price = priceOf(low);
  const investorShares = floorShares(divideRational(investment, price));
  if (investorShares <= 0n) {
    throw equityError("roundInvestmentBelowOneShare", {}, { field: "investment" });
  }
  const { conversions } = convertAtRound(input.convertibles, price, input.fullyDilutedBefore);
  const conversionShares = conversions.reduce((sum, conversion) => sum + conversion.shares, 0n);
  const antiDilution = input.protectedClasses.flatMap((entry) => {
    const adjusted = adjustedConversionPrice({
      method: entry.method,
      conversionPrice: entry.conversionPrice,
      newIssuePrice: price,
      newMoney: investment,
      newShares: rational(investorShares),
      fullyDilutedBefore: input.fullyDilutedBefore,
      outstandingBefore: input.outstandingBefore,
    });
    if (compareRational(adjusted, entry.conversionPrice) >= 0) return [];
    const issueValue = multiplyRational(
      rational(entry.outstandingShares),
      entry.originalIssuePrice,
    );
    const additional =
      floorShares(divideRational(issueValue, adjusted)) -
      floorShares(divideRational(issueValue, entry.conversionPrice));
    return [{ entry, adjusted, additional }];
  });
  const antiDilutionShares = antiDilution.reduce((sum, row) => sum + row.additional, 0n);
  const beforePool =
    input.fullyDilutedBefore + conversionShares + antiDilutionShares + investorShares;
  const poolExact = poolTopUpExact(input, target, rational(beforePool));
  const poolTopUp = ceilShares(poolExact);
  const fullyDilutedAfter = beforePool + poolTopUp;
  const poolAfter = input.poolAvailableBefore + poolTopUp;
  const percent = (part: bigint, whole: bigint): string =>
    whole > 0n ? formatPercent(rational(part, whole)) : "0.0000";
  const afterByHolder = new Map(input.holdersBefore);
  for (const conversion of conversions) {
    const holder = input.convertibleHolders.get(conversion.securityId);
    if (holder) afterByHolder.set(holder, (afterByHolder.get(holder) ?? 0n) + conversion.shares);
  }
  const holderKeys = [...afterByHolder.keys()].sort((a, b) => {
    const diff = (afterByHolder.get(b) ?? 0n) - (afterByHolder.get(a) ?? 0n);
    return diff > 0n ? 1 : diff < 0n ? -1 : a < b ? -1 : 1;
  });
  const dilution: RoundModelDilutionRow[] = holderKeys.map((key) => ({
    key,
    kind: "holder",
    sharesBefore: (input.holdersBefore.get(key) ?? 0n).toString(),
    sharesAfter: (afterByHolder.get(key) ?? 0n).toString(),
    percentBefore: percent(input.holdersBefore.get(key) ?? 0n, input.fullyDilutedBefore),
    percentAfter: percent(afterByHolder.get(key) ?? 0n, fullyDilutedAfter),
  }));
  if (antiDilutionShares > 0n) {
    dilution.push({
      key: "anti_dilution",
      kind: "anti_dilution",
      sharesBefore: "0",
      sharesAfter: antiDilutionShares.toString(),
      percentBefore: "0.0000",
      percentAfter: percent(antiDilutionShares, fullyDilutedAfter),
    });
  }
  dilution.push({
    key: "new_investors",
    kind: "new_investors",
    sharesBefore: "0",
    sharesAfter: investorShares.toString(),
    percentBefore: "0.0000",
    percentAfter: percent(investorShares, fullyDilutedAfter),
  });
  dilution.push({
    key: "pool",
    kind: "pool",
    sharesBefore: input.poolAvailableBefore.toString(),
    sharesAfter: poolAfter.toString(),
    percentBefore: percent(input.poolAvailableBefore, input.fullyDilutedBefore),
    percentAfter: percent(poolAfter, fullyDilutedAfter),
  });
  return {
    pricePerShare: formatPrice(price),
    preMoneyValuation: formatMoney(pre),
    investment: formatMoney(investment),
    postMoneyValuation: formatMoney(addRational(pre, investment)),
    fullyDilutedBefore: input.fullyDilutedBefore.toString(),
    investorShares: investorShares.toString(),
    conversionShares: conversionShares.toString(),
    antiDilutionShares: antiDilutionShares.toString(),
    poolTopUp: poolTopUp.toString(),
    poolAfter: poolAfter.toString(),
    fullyDilutedAfter: fullyDilutedAfter.toString(),
    investorPercent: percent(investorShares, fullyDilutedAfter),
    poolPercentAfter: percent(poolAfter, fullyDilutedAfter),
    investorCashRounding: formatMoney(
      subtractRational(investment, multiplyRational(rational(investorShares), price)),
    ),
    conversions: conversions.map((conversion) => ({
      securityId: conversion.securityId,
      holderPartyId: input.convertibleHolders.get(conversion.securityId) ?? null,
      pricedBy: conversion.pricedBy,
      amount: formatMoney(conversion.amount),
      price: formatPrice(conversion.price),
      shares: conversion.shares.toString(),
    })),
    antiDilution: antiDilution.map(({ entry, adjusted, additional }) => ({
      shareClassId: entry.shareClassId,
      code: entry.code,
      method: entry.method,
      previousConversionPrice: formatPrice(entry.conversionPrice),
      newConversionPrice: formatPrice(adjusted),
      additionalShares: additional.toString(),
    })),
    dilution,
  };
}
