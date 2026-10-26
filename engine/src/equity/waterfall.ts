/**
 * Liquidation waterfall: how an exit's proceeds reach each class, holder
 * and security.
 *
 * 1. Convertible notes are debt: principal and accrued interest are paid
 *    first, pro rata among notes when the proceeds fall short.
 * 2. Preferred classes that keep their preference are paid by seniority,
 *    most senior first (higher seniority number), pro rata within a tier.
 *    A class's preference is its liquidation multiple times each outstanding
 *    share's preference price: the class's original issue price, or, when
 *    the class measures its preference on the amount paid, what was paid for
 *    the share's certificate (a SAFE or note conversion's converted amount,
 *    not the round price). Within a class the preference is shared by each
 *    holding's own preference and any participation by shares. A SAFE that takes its cash-out
 *    amount (its purchase amount) is paid in the most junior preferred tier
 *    (ahead of common when no preferred class keeps a preference).
 * 3. The residual is shared per common-equivalent share by common stock,
 *    converted preferred, participating preferred (as converted) and the
 *    options and warrants that are in the money at the resulting price —
 *    their exercise prices join the pot and their shares join the count, so
 *    the in-the-money set is iterated until it no longer changes. RSUs take
 *    part with no exercise price. A capped participating class stops at its
 *    cap (cap multiple times original issue price per share, preference
 *    included) and the excess is shared by the others.
 * 4. Each non-participating or capped preferred class converts to common
 *    when that pays it more, given the other classes' choices. Each capped
 *    SAFE likewise takes the greater of its cash-out amount and its
 *    conversion amount (standard SAFE liquidity terms): converting, it joins
 *    the residual with purchase amount / liquidity price shares, the
 *    liquidity price being its cap over the liquidity capitalization
 *    (outstanding shares as converted and the awards taking part; a
 *    post-money SAFE's capitalization also counts every converting SAFE's
 *    shares, solved exactly). The choices are revisited one holder at a time
 *    until none would change. Terms whose choices never settle refuse
 *    instead of printing an arbitrary answer.
 *
 * Amounts are exact until the end, then rounded to the currency's minor
 * unit by largest remainder so the payouts sum to the exit value exactly.
 */
import { equityError } from "./errors.ts";
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
  /** Preference price per share before the liquidation multiple (absent: the class's original issue price). */
  preferencePrice?: Rational | null;
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
  /** Amount owed: a note's principal and interest, a SAFE's purchase amount (in the exit's currency). */
  amount: Rational;
  /** A SAFE's valuation cap in the exit's currency (null: uncapped, cash-out only). */
  cap?: Rational | null;
  postMoney?: boolean;
}

/** Converting post-money claims at or above this share of the company have no meaningful solution. */
const MAX_CONVERTING_CLAIM: Rational = rational(95n, 100n);

export interface WaterfallInput {
  /** Exit proceeds available to equity and convertible holders (exact money). */
  exitValue: Rational;
  classes: readonly WaterfallClass[];
  awards: readonly WaterfallAward[];
  convertibles: readonly WaterfallConvertible[];
  /** Currency minor unit as a power of ten in ledger units (4 = 0.0001, 2 = 0.01). */
  minorUnitScale: number;
}

export interface WaterfallSafeRow {
  securityId: string;
  holderPartyId: string;
  /** Whether the SAFE takes its conversion amount rather than its cash-out amount. */
  converted: boolean;
  shares: string;
  amount: string;
  /** The SAFE's cash-out amount (its purchase amount). */
  cashOutAmount: string;
  /** What the other choice would pay it, given the others' choices (null for an uncapped SAFE, which only cashes out). */
  alternativeAmount: string | null;
}

export interface WaterfallClassRow {
  shareClassId: string;
  code: string;
  kind: ShareClassKind;
  seniority: number;
  participationMode: Participation;
  converted: boolean;
  preference: string;
  participation: string;
  total: string;
  perShare: string;
  /** The liquidation preference the class holds: its multiple times each outstanding share's preference price. */
  preferenceEntitlement: string;
  /** A capped participating class's cap, preference included (null otherwise). */
  participationCap: string | null;
  /** What the other choice (convert, or keep the preference) would pay the class, given the others' choices; null for a class with no choice. */
  alternativeTotal: string | null;
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
  safes: WaterfallSafeRow[];
  unallocated: string;
}

interface Distribution {
  classPreference: Map<string, Rational>;
  classParticipation: Map<string, Rational>;
  awardGross: Map<string, Rational>;
  convertiblePaid: Map<string, Rational>;
  /** Common-equivalent shares of the SAFEs taking their conversion amount. */
  safeShares: Map<string, Rational>;
  price: Rational;
  unallocated: Rational;
}

const sharesOf = (shareClass: WaterfallClass): bigint =>
  shareClass.holdings.reduce((sum, holding) => sum + holding.shares, 0n);

/** A holding's preference price per share before the multiple: its own, else the class's original issue price. */
function holdingPrice(shareClass: WaterfallClass, holding: WaterfallHolding): Rational | null {
  return holding.preferencePrice ?? shareClass.originalIssuePrice;
}

/** What a holding's shares were paid at, before the multiple. */
function holdingBasis(shareClass: WaterfallClass, holding: WaterfallHolding): Rational {
  const price = holdingPrice(shareClass, holding);
  return price ? multiplyRational(rational(holding.shares), price) : ZERO;
}

function classBasis(shareClass: WaterfallClass): Rational {
  return sumRational(shareClass.holdings.map((holding) => holdingBasis(shareClass, holding)));
}

function preferenceOf(shareClass: WaterfallClass): Rational {
  if (shareClass.kind !== "preferred" || !shareClass.originalIssuePrice) return ZERO;
  return multiplyRational(classBasis(shareClass), shareClass.liquidationMultiple);
}

function capOf(shareClass: WaterfallClass): Rational | null {
  if (
    shareClass.participation !== "capped" ||
    !shareClass.participationCapMultiple ||
    !shareClass.originalIssuePrice
  )
    return null;
  return multiplyRational(classBasis(shareClass), shareClass.participationCapMultiple);
}

const asConverted = (shareClass: WaterfallClass): Rational =>
  multiplyRational(rational(sharesOf(shareClass)), shareClass.conversionRatio);

/**
 * Common-equivalent shares each converting SAFE takes. Null when the
 * converting post-money claims leave no meaningful capitalization.
 */
function safeConversionShares(
  input: WaterfallInput,
  converting: ReadonlySet<string>,
): Map<string, Rational> | null {
  const safes = input.convertibles.filter(
    (convertible) =>
      convertible.kind === "safe" && convertible.cap && converting.has(convertible.securityId),
  );
  const out = new Map<string, Rational>();
  if (safes.length === 0) return out;
  const ratioByClass = new Map(
    input.classes.map((shareClass) => [shareClass.shareClassId, shareClass.conversionRatio]),
  );
  const base = addRational(
    sumRational(input.classes.map(asConverted)),
    sumRational(
      input.awards.map((award) =>
        multiplyRational(
          rational(award.shares),
          ratioByClass.get(award.shareClassId) ?? rational(1n),
        ),
      ),
    ),
  );
  if (base.numerator <= 0n) return null;
  let fixed = ZERO;
  let claim = ZERO;
  for (const safe of safes) {
    if (safe.postMoney) claim = addRational(claim, divideRational(safe.amount, safe.cap!));
    else fixed = addRational(fixed, multiplyRational(safe.amount, divideRational(base, safe.cap!)));
  }
  if (compareRational(claim, MAX_CONVERTING_CLAIM) >= 0) return null;
  const capitalization = divideRational(
    addRational(base, fixed),
    subtractRational(rational(1n), claim),
  );
  for (const safe of safes) {
    out.set(
      safe.securityId,
      safe.postMoney
        ? multiplyRational(divideRational(safe.amount, safe.cap!), capitalization)
        : multiplyRational(safe.amount, divideRational(base, safe.cap!)),
    );
  }
  return out;
}

/** Pay equal-ranking claims from what is available, pro rata when short. */
function payTier(
  claims: readonly { id: string; amount: Rational }[],
  available: Rational,
  into: Map<string, Rational>,
): Rational {
  const want = sumRational(claims.map((claim) => claim.amount));
  if (want.numerator === 0n) return available;
  const pay = minRational(available, want);
  for (const claim of claims)
    into.set(
      claim.id,
      addRational(
        into.get(claim.id) ?? ZERO,
        multiplyRational(claim.amount, divideRational(pay, want)),
      ),
    );
  return subtractRational(available, pay);
}

function distribute(
  input: WaterfallInput,
  afterNotes: Rational,
  converting: ReadonlySet<string>,
  notesPaid: ReadonlyMap<string, Rational>,
): Distribution | null {
  const classPreference = new Map<string, Rational>();
  const classParticipation = new Map<string, Rational>();
  const convertiblePaid = new Map(notesPaid);
  const safeShares = safeConversionShares(input, converting);
  if (!safeShares) return null;
  let available = afterNotes;
  const keeping = input.classes.filter(
    (shareClass) =>
      shareClass.kind === "preferred" &&
      !converting.has(shareClass.shareClassId) &&
      preferenceOf(shareClass).numerator > 0n,
  );
  const tiers = [...new Set(keeping.map((shareClass) => shareClass.seniority))].sort(
    (a, b) => b - a,
  );
  const safes = input.convertibles.filter(
    (convertible) => convertible.kind === "safe" && !safeShares.has(convertible.securityId),
  );
  const juniorTier = tiers.length > 0 ? tiers[tiers.length - 1] : null;
  for (const tier of tiers) {
    const claims = keeping
      .filter((shareClass) => shareClass.seniority === tier)
      .map((shareClass) => ({
        id: `class:${shareClass.shareClassId}`,
        amount: preferenceOf(shareClass),
      }));
    if (tier === juniorTier)
      claims.push(...safes.map((safe) => ({ id: `safe:${safe.securityId}`, amount: safe.amount })));
    const paid = new Map<string, Rational>();
    available = payTier(claims, available, paid);
    for (const [id, amount] of paid) {
      if (id.startsWith("class:")) classPreference.set(id.slice(6), amount);
      else convertiblePaid.set(id.slice(5), amount);
    }
  }
  if (juniorTier === null && safes.length > 0) {
    const paid = new Map<string, Rational>();
    available = payTier(
      safes.map((safe) => ({ id: safe.securityId, amount: safe.amount })),
      available,
      paid,
    );
    for (const [id, amount] of paid) convertiblePaid.set(id, amount);
  }
  // Residual participants: common, converted preferred, and participating preferred as converted.
  const participants = input.classes.filter(
    (shareClass) =>
      shareClass.kind === "common" ||
      converting.has(shareClass.shareClassId) ||
      shareClass.participation !== "none",
  );
  const ratioByClass = new Map(
    input.classes.map((shareClass) => [shareClass.shareClassId, shareClass.conversionRatio]),
  );
  const awardUnits = (award: WaterfallAward): Rational =>
    multiplyRational(rational(award.shares), ratioByClass.get(award.shareClassId) ?? rational(1n));
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
        addRational(
          sumRational(
            participants
              .filter((shareClass) => !capped.has(shareClass.shareClassId))
              .map(asConverted),
          ),
          sumRational(inMoney.map(awardUnits)),
        ),
        sumRational([...safeShares.values()]),
      );
      price =
        count.numerator > 0n && compareRational(pot, ZERO) > 0 ? divideRational(pot, count) : ZERO;
      const next = inMoney.filter(
        (award) =>
          compareRational(
            multiplyRational(price, ratioByClass.get(award.shareClassId) ?? rational(1n)),
            award.strike,
          ) > 0,
      );
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
    classParticipation.set(
      shareClass.shareClassId,
      capped.get(shareClass.shareClassId) ?? multiplyRational(price, asConverted(shareClass)),
    );
  }
  const awardGross = new Map<string, Rational>();
  for (const award of inMoney)
    awardGross.set(award.securityId, multiplyRational(price, awardUnits(award)));
  for (const [securityId, shares] of safeShares)
    convertiblePaid.set(securityId, multiplyRational(price, shares));
  const strikes = sumRational(
    inMoney.map((award) => multiplyRational(rational(award.shares), award.strike)),
  );
  const distributed = addRational(
    addRational(
      sumRational([...classParticipation.values()]),
      sumRational([...awardGross.values()]),
    ),
    sumRational([...safeShares.keys()].map((securityId) => convertiblePaid.get(securityId)!)),
  );
  const unallocated = subtractRational(addRational(available, strikes), distributed);
  return {
    classPreference,
    classParticipation,
    awardGross,
    convertiblePaid,
    safeShares,
    price,
    unallocated: compareRational(unallocated, ZERO) > 0 ? unallocated : ZERO,
  };
}

function classTotal(distribution: Distribution, shareClassId: string): Rational {
  return addRational(
    distribution.classPreference.get(shareClassId) ?? ZERO,
    distribution.classParticipation.get(shareClassId) ?? ZERO,
  );
}

/** What a preferred class or a SAFE takes in a distribution. */
function electorTotal(distribution: Distribution, id: string, safe: boolean): Rational {
  return safe ? (distribution.convertiblePaid.get(id) ?? ZERO) : classTotal(distribution, id);
}

/** Largest-remainder rounding of exact amounts to a quantum, preserving their exact total. */
function roundToTotal(amounts: readonly Rational[], quantum: Rational): bigint[] {
  const total = sumRational(amounts);
  const units = amounts.map((amount) => divideRational(amount, quantum));
  const floors = units.map((unit) => unit.numerator / unit.denominator);
  const target = divideRational(total, quantum);
  let remaining =
    target.numerator / target.denominator - floors.reduce((sum, value) => sum + value, 0n);
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
    throw equityError("exitValueNegative", {}, { field: "exitValue" });
  }
  if (
    !Number.isInteger(input.minorUnitScale) ||
    input.minorUnitScale < 0 ||
    input.minorUnitScale > 4
  ) {
    throw equityError("currencyPrecisionUnsupported");
  }
  const notesPaid = new Map<string, Rational>();
  const notes = input.convertibles.filter((convertible) => convertible.kind === "note");
  const afterNotes = payTier(
    notes.map((note) => ({ id: note.securityId, amount: note.amount })),
    input.exitValue,
    notesPaid,
  );
  const candidates: { id: string; safe: boolean }[] = [
    ...input.classes
      .filter(
        (shareClass) => shareClass.kind === "preferred" && shareClass.participation !== "full",
      )
      .sort((a, b) => a.seniority - b.seniority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((shareClass) => ({ id: shareClass.shareClassId, safe: false })),
    ...input.convertibles
      .filter((convertible) => convertible.kind === "safe" && convertible.cap)
      .map((convertible) => ({ id: convertible.securityId, safe: true })),
  ];
  let converting = new Set<string>();
  let distribution = distribute(input, afterNotes, converting, notesPaid)!;
  let settled = false;
  for (let pass = 0; pass <= 4 * candidates.length + 4; pass += 1) {
    let changed = false;
    for (const candidate of candidates) {
      const toggled = new Set(converting);
      if (toggled.has(candidate.id)) toggled.delete(candidate.id);
      else toggled.add(candidate.id);
      const alternative = distribute(input, afterNotes, toggled, notesPaid);
      if (!alternative) continue;
      if (
        compareRational(
          electorTotal(alternative, candidate.id, candidate.safe),
          electorTotal(distribution, candidate.id, candidate.safe),
        ) > 0
      ) {
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
    throw equityError("waterfallUnsettled");
  }
  // What each elector's other choice would pay it, holding the others' settled choices.
  const alternatives = new Map<string, Rational>();
  for (const candidate of candidates) {
    const toggled = new Set(converting);
    if (toggled.has(candidate.id)) toggled.delete(candidate.id);
    else toggled.add(candidate.id);
    const alternative = distribute(input, afterNotes, toggled, notesPaid);
    if (alternative)
      alternatives.set(candidate.id, electorTotal(alternative, candidate.id, candidate.safe));
  }
  // Exact lines: holdings by class, awards net of exercise price, convertibles, unallocated.
  const lines: { payout: WaterfallPayout | null; exact: Rational }[] = [];
  for (const shareClass of input.classes) {
    // The preference follows each holding's own preference; participation follows shares.
    const preference = distribution.classPreference.get(shareClass.shareClassId) ?? ZERO;
    const participation = distribution.classParticipation.get(shareClass.shareClassId) ?? ZERO;
    const shares = sharesOf(shareClass);
    const basis = classBasis(shareClass);
    for (const holding of shareClass.holdings) {
      const fromPreference =
        basis.numerator > 0n
          ? multiplyRational(preference, divideRational(holdingBasis(shareClass, holding), basis))
          : ZERO;
      const fromParticipation =
        shares > 0n ? multiplyRational(participation, rational(holding.shares, shares)) : ZERO;
      lines.push({
        payout: {
          securityId: holding.securityId,
          holderPartyId: holding.holderPartyId,
          kind: "share",
          shareClassId: shareClass.shareClassId,
          amount: "",
        },
        exact: addRational(fromPreference, fromParticipation),
      });
    }
  }
  for (const award of input.awards) {
    const gross = distribution.awardGross.get(award.securityId);
    const exact = gross
      ? subtractRational(gross, multiplyRational(rational(award.shares), award.strike))
      : ZERO;
    lines.push({
      payout: {
        securityId: award.securityId,
        holderPartyId: award.holderPartyId,
        kind: "award",
        shareClassId: award.shareClassId,
        amount: "",
      },
      exact,
    });
  }
  for (const convertible of input.convertibles) {
    lines.push({
      payout: {
        securityId: convertible.securityId,
        holderPartyId: convertible.holderPartyId,
        kind: convertible.kind,
        shareClassId: null,
        amount: "",
      },
      exact: distribution.convertiblePaid.get(convertible.securityId) ?? ZERO,
    });
  }
  lines.push({ payout: null, exact: distribution.unallocated });
  const quantum = rational(1n, 10n ** BigInt(input.minorUnitScale));
  const rounded = roundToTotal(
    lines.map((line) => line.exact),
    quantum,
  );
  const toMoney = (units: bigint): string => {
    const ledger = units * 10n ** BigInt(4 - input.minorUnitScale);
    const negative = ledger < 0n;
    const digits = (negative ? -ledger : ledger).toString().padStart(5, "0");
    return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
  };
  const payouts: WaterfallPayout[] = [];
  const securityUnits = new Map<string, bigint>();
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
    securityUnits.set(
      line.payout.securityId,
      (securityUnits.get(line.payout.securityId) ?? 0n) + units,
    );
    holderTotals.set(
      line.payout.holderPartyId,
      (holderTotals.get(line.payout.holderPartyId) ?? 0n) + units,
    );
    if (line.payout.kind === "share" && line.payout.shareClassId) {
      classTotals.set(
        line.payout.shareClassId,
        (classTotals.get(line.payout.shareClassId) ?? 0n) + units,
      );
    }
  });
  const exitUnits = quantize(input.exitValue, input.minorUnitScale, "half_up");
  const classes: WaterfallClassRow[] = input.classes.map((shareClass) => {
    const shares = sharesOf(shareClass);
    const units = classTotals.get(shareClass.shareClassId) ?? 0n;
    const cap = capOf(shareClass);
    const alternative = alternatives.get(shareClass.shareClassId);
    return {
      shareClassId: shareClass.shareClassId,
      code: shareClass.code,
      kind: shareClass.kind,
      seniority: shareClass.seniority,
      participationMode: shareClass.participation,
      converted: converting.has(shareClass.shareClassId),
      preference: toMoney(
        quantize(
          distribution.classPreference.get(shareClass.shareClassId) ?? ZERO,
          input.minorUnitScale,
          "half_up",
        ),
      ),
      participation: toMoney(
        quantize(
          distribution.classParticipation.get(shareClass.shareClassId) ?? ZERO,
          input.minorUnitScale,
          "half_up",
        ),
      ),
      total: toMoney(units),
      perShare:
        shares > 0n
          ? formatPrice(
              divideRational(classTotal(distribution, shareClass.shareClassId), rational(shares)),
            )
          : "0.0000000000",
      preferenceEntitlement: toMoney(
        quantize(preferenceOf(shareClass), input.minorUnitScale, "half_up"),
      ),
      participationCap: cap ? toMoney(quantize(cap, input.minorUnitScale, "half_up")) : null,
      alternativeTotal: alternative
        ? toMoney(quantize(alternative, input.minorUnitScale, "half_up"))
        : null,
    };
  });
  return {
    exitValue: toMoney(exitUnits),
    pricePerCommonShare: formatPrice(distribution.price),
    classes,
    payouts,
    holders: [...holderTotals.entries()]
      .sort(([aId, a], [bId, b]) => (a === b ? (aId < bId ? -1 : 1) : a > b ? -1 : 1))
      .map(([holderPartyId, units]) => ({
        holderPartyId,
        amount: toMoney(units),
        percent: exitUnits > 0n ? formatPercent(rational(units, exitUnits)) : "0.0000",
      })),
    safes: input.convertibles
      .filter((convertible) => convertible.kind === "safe")
      .map((convertible) => {
        const shares = distribution.safeShares.get(convertible.securityId);
        const units = securityUnits.get(convertible.securityId) ?? 0n;
        const alternative = alternatives.get(convertible.securityId);
        return {
          securityId: convertible.securityId,
          holderPartyId: convertible.holderPartyId,
          converted: Boolean(shares),
          shares: shares ? formatPrice(shares) : "0.0000000000",
          amount: toMoney(units),
          cashOutAmount: toMoney(quantize(convertible.amount, input.minorUnitScale, "half_up")),
          alternativeAmount: alternative
            ? toMoney(quantize(alternative, input.minorUnitScale, "half_up"))
            : null,
        };
      }),
    unallocated: toMoney(unallocatedUnits),
  };
}
