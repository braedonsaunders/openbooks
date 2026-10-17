/**
 * Liquidation waterfall: how an exit's proceeds reach each class, holder
 * and security.
 *
 * 1. Convertible notes are debt: principal and accrued interest are paid
 *    first, pro rata among notes when the proceeds fall short.
 * 2. Preferred classes that keep their preference are paid by seniority,
 *    most senior first (higher seniority number), pro rata within a tier.
 *    A class's preference is its liquidation multiple times its original
 *    issue price per outstanding share. Outstanding SAFEs take their
 *    purchase amount in the most junior preferred tier (ahead of common
 *    when no preferred class keeps a preference).
 * 3. The residual is shared per common-equivalent share by common stock,
 *    converted preferred, participating preferred (as converted) and the
 *    options and warrants that are in the money at the resulting price —
 *    their exercise prices join the pot and their shares join the count, so
 *    the in-the-money set is iterated until it no longer changes. RSUs take
 *    part with no exercise price. A capped participating class stops at its
 *    cap (cap multiple times original issue price per share, preference
 *    included) and the excess is shared by the others.
 * 4. Each non-participating or capped preferred class converts to common
 *    when that pays it more, given the other classes' choices; the choices
 *    are revisited one class at a time until none would change. Terms whose
 *    choices never settle refuse instead of printing an arbitrary answer.
 *
 * Amounts are exact until the end, then rounded to the currency's minor
 * unit by largest remainder so the payouts sum to the exit value exactly.
 */
import { EquityError } from "./errors.ts";
import {
  addRational,
  compareRational,
  divideRational,
  formatPercent,
  formatPrice,
  minRational,
  multiplyRational,
  quantize,
  rational,
  subtractRational,
  sumRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import type { Participation, ShareClassKind } from "./types.ts";

export interface WaterfallHolding {
  securityId: string;
  holderPartyId: string;
  shares: bigint;
}

export interface WaterfallClass {
  shareClassId: string;
  code: string;
  kind: ShareClassKind;
  seniority: number;
  liquidationMultiple: Rational;
  participation: Participation;
  participationCapMultiple: Rational | null;
  originalIssuePrice: Rational | null;
  /** Common shares per share of the class. */
  conversionRatio: Rational;
  holdings: readonly WaterfallHolding[];
}

export interface WaterfallAward {
  securityId: string;
  holderPartyId: string;
  shareClassId: string;
  /** Units taking part in the exit. */
  shares: bigint;
  /** Exercise price per unit (zero for RSUs). */
  strike: Rational;
}

export interface WaterfallConvertible {
  securityId: string;
  holderPartyId: string;
  kind: "safe" | "note";
  amount: Rational;
}

export interface WaterfallInput {
  /** Exit proceeds available to equity and convertible holders (exact money). */
  exitValue: Rational;
  classes: readonly WaterfallClass[];
  awards: readonly WaterfallAward[];
  convertibles: readonly WaterfallConvertible[];
  /** Currency minor unit as a power of ten in ledger units (4 = 0.0001, 2 = 0.01). */
  minorUnitScale: number;
}

export interface WaterfallClassRow {
  shareClassId: string;
  code: string;
  converted: boolean;
  preference: string;
  participation: string;
  total: string;
  perShare: string;
}

export interface WaterfallPayout {
  securityId: string;
  holderPartyId: string;
  kind: "share" | "award" | "safe" | "note";
  shareClassId: string | null;
  amount: string;
}

export interface WaterfallResult {
  exitValue: string;
  pricePerCommonShare: string;
  classes: WaterfallClassRow[];
  payouts: WaterfallPayout[];
  holders: { holderPartyId: string; amount: string; percent: string }[];
  unallocated: string;
}

interface Distribution {
  classPreference: Map<string, Rational>;
  classParticipation: Map<string, Rational>;
  awardGross: Map<string, Rational>;
  convertiblePaid: Map<string, Rational>;
  price: Rational;
  unallocated: Rational;
}

const sharesOf = (shareClass: WaterfallClass): bigint => shareClass.holdings.reduce((sum, holding) => sum + holding.shares, 0n);

function preferenceOf(shareClass: WaterfallClass): Rational {
  if (shareClass.kind !== "preferred" || !shareClass.originalIssuePrice) return ZERO;
  return multiplyRational(multiplyRational(rational(sharesOf(shareClass)), shareClass.originalIssuePrice), shareClass.liquidationMultiple);
}

function capOf(shareClass: WaterfallClass): Rational | null {
  if (shareClass.participation !== "capped" || !shareClass.participationCapMultiple || !shareClass.originalIssuePrice) return null;
  return multiplyRational(multiplyRational(rational(sharesOf(shareClass)), shareClass.originalIssuePrice), shareClass.participationCapMultiple);
}

const asConverted = (shareClass: WaterfallClass): Rational => multiplyRational(rational(sharesOf(shareClass)), shareClass.conversionRatio);

/** Pay equal-ranking claims from what is available, pro rata when short. */
function payTier(claims: readonly { id: string; amount: Rational }[], available: Rational, into: Map<string, Rational>): Rational {
  const want = sumRational(claims.map((claim) => claim.amount));
  if (want.numerator === 0n) return available;
  const pay = minRational(available, want);
  for (const claim of claims) into.set(claim.id, addRational(into.get(claim.id) ?? ZERO, multiplyRational(claim.amount, divideRational(pay, want))));
  return subtractRational(available, pay);
}

function distribute(input: WaterfallInput, afterNotes: Rational, converting: ReadonlySet<string>, notesPaid: ReadonlyMap<string, Rational>): Distribution {
  const classPreference = new Map<string, Rational>();
  const classParticipation = new Map<string, Rational>();
  const convertiblePaid = new Map(notesPaid);
  let available = afterNotes;
  const keeping = input.classes.filter((shareClass) => shareClass.kind === "preferred" && !converting.has(shareClass.shareClassId) && preferenceOf(shareClass).numerator > 0n);
  const tiers = [...new Set(keeping.map((shareClass) => shareClass.seniority))].sort((a, b) => b - a);
  const safes = input.convertibles.filter((convertible) => convertible.kind === "safe");
  const juniorTier = tiers.length > 0 ? tiers[tiers.length - 1] : null;
  for (const tier of tiers) {
    const claims = keeping.filter((shareClass) => shareClass.seniority === tier).map((shareClass) => ({ id: `class:${shareClass.shareClassId}`, amount: preferenceOf(shareClass) }));
    if (tier === juniorTier) claims.push(...safes.map((safe) => ({ id: `safe:${safe.securityId}`, amount: safe.amount })));
    const paid = new Map<string, Rational>();
    available = payTier(claims, available, paid);
    for (const [id, amount] of paid) {
      if (id.startsWith("class:")) classPreference.set(id.slice(6), amount);
      else convertiblePaid.set(id.slice(5), amount);
    }
  }
  if (juniorTier === null && safes.length > 0) {
    const paid = new Map<string, Rational>();
    available = payTier(safes.map((safe) => ({ id: safe.securityId, amount: safe.amount })), available, paid);
    for (const [id, amount] of paid) convertiblePaid.set(id, amount);
  }
  // Residual participants: common, converted preferred, and participating preferred as converted.
  const participants = input.classes.filter((shareClass) =>
    shareClass.kind === "common" || converting.has(shareClass.shareClassId) || shareClass.participation !== "none");
  const ratioByClass = new Map(input.classes.map((shareClass) => [shareClass.shareClassId, shareClass.conversionRatio]));
  const awardUnits = (award: WaterfallAward): Rational => multiplyRational(rational(award.shares), ratioByClass.get(award.shareClassId) ?? rational(1n));
  const capped = new Map<string, Rational>();
  let price = ZERO;
  let inMoney: WaterfallAward[] = [];
  for (let capPass = 0; capPass <= participants.length + 1; capPass += 1) {
    inMoney = input.awards.filter((award) => award.shares > 0n);
    for (let pass = 0; pass <= input.awards.length + 1; pass += 1) {
      const pot = addRational(
        subtractRational(available, sumRational([...capped.values()])),
        sumRational(inMoney.map((award) => multiplyRational(rational(award.shares), award.strike))),
      );
      const count = addRational(
        sumRational(participants.filter((shareClass) => !capped.has(shareClass.shareClassId)).map(asConverted)),
        sumRational(inMoney.map(awardUnits)),
      );
      price = count.numerator > 0n && compareRational(pot, ZERO) > 0 ? divideRational(pot, count) : ZERO;
      const next = inMoney.filter((award) => compareRational(multiplyRational(price, ratioByClass.get(award.shareClassId) ?? rational(1n)), award.strike) > 0);
      if (next.length === inMoney.length) break;
      inMoney = next;
    }
    let grew = false;
    for (const shareClass of participants) {
      if (capped.has(shareClass.shareClassId) || converting.has(shareClass.shareClassId)) continue;
      const cap = capOf(shareClass);
      if (!cap) continue;
      const preference = classPreference.get(shareClass.shareClassId) ?? ZERO;
      const participation = multiplyRational(price, asConverted(shareClass));
      if (compareRational(addRational(preference, participation), cap) > 0) {
        const room = subtractRational(cap, preference);
        capped.set(shareClass.shareClassId, compareRational(room, ZERO) > 0 ? room : ZERO);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const shareClass of participants) {
    classParticipation.set(shareClass.shareClassId, capped.get(shareClass.shareClassId) ?? multiplyRational(price, asConverted(shareClass)));
  }
  const awardGross = new Map<string, Rational>();
  for (const award of inMoney) awardGross.set(award.securityId, multiplyRational(price, awardUnits(award)));
  const strikes = sumRational(inMoney.map((award) => multiplyRational(rational(award.shares), award.strike)));
  const distributed = addRational(sumRational([...classParticipation.values()]), sumRational([...awardGross.values()]));
  const unallocated = subtractRational(addRational(available, strikes), distributed);
  return {
    classPreference, classParticipation, awardGross, convertiblePaid, price,
    unallocated: compareRational(unallocated, ZERO) > 0 ? unallocated : ZERO,
  };
}

function classTotal(distribution: Distribution, shareClassId: string): Rational {
  return addRational(distribution.classPreference.get(shareClassId) ?? ZERO, distribution.classParticipation.get(shareClassId) ?? ZERO);
}

/** Largest-remainder rounding of exact amounts to a quantum, preserving their exact total. */
function roundToTotal(amounts: readonly Rational[], quantum: Rational): bigint[] {
  const total = sumRational(amounts);
  const units = amounts.map((amount) => divideRational(amount, quantum));
  const floors = units.map((unit) => unit.numerator / unit.denominator);
  const target = divideRational(total, quantum);
  let remaining = target.numerator / target.denominator - floors.reduce((sum, value) => sum + value, 0n);
  const order = units
    .map((unit, index) => ({ index, remainder: subtractRational(unit, rational(floors[index]!)) }))
    .sort((a, b) => compareRational(b.remainder, a.remainder) || a.index - b.index);
  const out = [...floors];
  for (const entry of order) {
    if (remaining <= 0n) break;
    out[entry.index]! += 1n;
    remaining -= 1n;
  }
  return out;
}

/** Run the waterfall at one exit value. */
export function runWaterfall(input: WaterfallInput): WaterfallResult {
  if (compareRational(input.exitValue, ZERO) < 0) {
    throw new EquityError("The exit value cannot be negative.", { code: "equity_waterfall_invalid", remedy: "Enter the proceeds available to equity holders.", field: "exitValue" });
  }
  if (!Number.isInteger(input.minorUnitScale) || input.minorUnitScale < 0 || input.minorUnitScale > 4) {
    throw new EquityError("The currency precision is not supported.", { code: "equity_currency_unknown", remedy: "Restore the currency in Company Settings → Currencies." });
  }
  const notesPaid = new Map<string, Rational>();
  const notes = input.convertibles.filter((convertible) => convertible.kind === "note");
  const afterNotes = payTier(notes.map((note) => ({ id: note.securityId, amount: note.amount })), input.exitValue, notesPaid);
  const candidates = input.classes
    .filter((shareClass) => shareClass.kind === "preferred" && shareClass.participation !== "full")
    .sort((a, b) => a.seniority - b.seniority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  let converting = new Set<string>();
  let distribution = distribute(input, afterNotes, converting, notesPaid);
  let settled = false;
  for (let pass = 0; pass <= 4 * candidates.length + 4; pass += 1) {
    let changed = false;
    for (const shareClass of candidates) {
      const toggled = new Set(converting);
      if (toggled.has(shareClass.shareClassId)) toggled.delete(shareClass.shareClassId);
      else toggled.add(shareClass.shareClassId);
      const alternative = distribute(input, afterNotes, toggled, notesPaid);
      if (compareRational(classTotal(alternative, shareClass.shareClassId), classTotal(distribution, shareClass.shareClassId)) > 0) {
        converting = toggled;
        distribution = alternative;
        changed = true;
        break;
      }
    }
    if (!changed) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    throw new EquityError("The preferred classes' conversion choices do not settle at this exit value.", {
      status: 409,
      code: "equity_waterfall_unsettled",
      remedy: "Review the classes' preferences, participation caps and seniority, or model a different exit value.",
    });
  }
  // Exact lines: holdings by class, awards net of exercise price, convertibles, unallocated.
  const lines: { payout: WaterfallPayout | null; exact: Rational }[] = [];
  for (const shareClass of input.classes) {
    const total = classTotal(distribution, shareClass.shareClassId);
    const shares = sharesOf(shareClass);
    for (const holding of shareClass.holdings) {
      const exact = shares > 0n ? multiplyRational(total, rational(holding.shares, shares)) : ZERO;
      lines.push({ payout: { securityId: holding.securityId, holderPartyId: holding.holderPartyId, kind: "share", shareClassId: shareClass.shareClassId, amount: "" }, exact });
    }
  }
  for (const award of input.awards) {
    const gross = distribution.awardGross.get(award.securityId);
    const exact = gross ? subtractRational(gross, multiplyRational(rational(award.shares), award.strike)) : ZERO;
    lines.push({ payout: { securityId: award.securityId, holderPartyId: award.holderPartyId, kind: "award", shareClassId: award.shareClassId, amount: "" }, exact });
  }
  for (const convertible of input.convertibles) {
    lines.push({ payout: { securityId: convertible.securityId, holderPartyId: convertible.holderPartyId, kind: convertible.kind, shareClassId: null, amount: "" }, exact: distribution.convertiblePaid.get(convertible.securityId) ?? ZERO });
  }
  lines.push({ payout: null, exact: distribution.unallocated });
  const quantum = rational(1n, 10n ** BigInt(input.minorUnitScale));
  const rounded = roundToTotal(lines.map((line) => line.exact), quantum);
  const toMoney = (units: bigint): string => {
    const ledger = units * 10n ** BigInt(4 - input.minorUnitScale);
    const negative = ledger < 0n;
    const digits = (negative ? -ledger : ledger).toString().padStart(5, "0");
    return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
  };
  const payouts: WaterfallPayout[] = [];
  const holderTotals = new Map<string, bigint>();
  const classTotals = new Map<string, bigint>();
  let unallocatedUnits = 0n;
  lines.forEach((line, index) => {
    const units = rounded[index]!;
    if (!line.payout) {
      unallocatedUnits = units;
      return;
    }
    payouts.push({ ...line.payout, amount: toMoney(units) });
    holderTotals.set(line.payout.holderPartyId, (holderTotals.get(line.payout.holderPartyId) ?? 0n) + units);
    if (line.payout.kind === "share" && line.payout.shareClassId) {
      classTotals.set(line.payout.shareClassId, (classTotals.get(line.payout.shareClassId) ?? 0n) + units);
    }
  });
  const exitUnits = quantize(input.exitValue, input.minorUnitScale, "half_up");
  const classes: WaterfallClassRow[] = input.classes.map((shareClass) => {
    const shares = sharesOf(shareClass);
    const units = classTotals.get(shareClass.shareClassId) ?? 0n;
    return {
      shareClassId: shareClass.shareClassId,
      code: shareClass.code,
      converted: converting.has(shareClass.shareClassId),
      preference: toMoney(quantize(distribution.classPreference.get(shareClass.shareClassId) ?? ZERO, input.minorUnitScale, "half_up")),
      participation: toMoney(quantize(distribution.classParticipation.get(shareClass.shareClassId) ?? ZERO, input.minorUnitScale, "half_up")),
      total: toMoney(units),
      perShare: shares > 0n ? formatPrice(divideRational(classTotal(distribution, shareClass.shareClassId), rational(shares))) : "0.0000000000",
    };
  });
  return {
    exitValue: toMoney(exitUnits),
    pricePerCommonShare: formatPrice(distribution.price),
    classes,
    payouts,
    holders: [...holderTotals.entries()]
      .sort(([aId, a], [bId, b]) => (a === b ? (aId < bId ? -1 : 1) : a > b ? -1 : 1))
      .map(([holderPartyId, units]) => ({ holderPartyId, amount: toMoney(units), percent: exitUnits > 0n ? formatPercent(rational(units, exitUnits)) : "0.0000" })),
    unallocated: toMoney(unallocatedUnits),
  };
}
