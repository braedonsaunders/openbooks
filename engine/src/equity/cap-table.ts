/**
 * The point-in-time cap table: every recorded security replayed through its
 * events and its class's splits as of one date.
 *
 * Each share-based security is accounted in the units it was issued in.
 * An event's quantity, stated in the terms of its own date, is converted
 * back to issue units exactly; the holding is then restated to the as-of
 * date through every later split at once and rounded down to whole shares
 * once (see splits.ts). Vesting is measured in issue units:
 *  - forfeitures remove unvested units from the end of the schedule;
 *  - exercises, settlements, expirations and transfers consume vested units;
 *    an option that admits early exercise may also be exercised before it
 *    vests, consuming its earliest unvested units, so the units it keeps
 *    vest only after the exercised ones;
 *  - cancellations and repurchases take unvested units first, then vested;
 *  - a void removes the security from its void date onward;
 *  - a governed reversal undoes one forfeiture, expiry, cancellation,
 *    repurchase or repayment from the reversal date onward.
 *
 * Ownership is stated on two bases. Outstanding counts issued shares, with
 * preferred shares as converted into common at the class's original issue
 * price over its conversion price. Fully diluted adds outstanding options,
 * RSUs and warrants (as converted) and the unallocated plan pools. SAFEs and
 * notes are reported beside the table with their converting amounts; they
 * take shares only when they convert.
 *
 * A preferred class's conversion price adjusts for splits of the common
 * class it converts into when its terms say so: from each such split's date
 * the price is divided by the split ratio, so the as-converted count follows
 * the common shares.
 */
import { equityError, fig } from "./errors.ts";
import { accruedInterest, type ConvertibleTerms } from "./convertibles.ts";
import {
  addRational,
  compareRational,
  divideRational,
  floorShares,
  formatMoney,
  formatPercent,
  formatPrice,
  minRational,
  multiplyRational,
  ONE,
  parseMoney,
  parsePrice,
  rational,
  subtractRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import { restatePrice, restateShares, splitFactor } from "./splits.ts";
import type {
  EquityBook,
  PlanRecord,
  SecurityEventKind,
  SecurityEventRecord,
  SecurityRecord,
  ShareClassRecord,
} from "./types.ts";
import { hasVestingSchedule, scheduledVested, type VestingTerms } from "./vesting.ts";

export type HoldingStatus =
  | "outstanding"
  | "exercised"
  | "settled"
  | "forfeited"
  | "expired"
  | "cancelled"
  | "repurchased"
  | "transferred"
  | "converted"
  | "void"
  | "not_issued";

/** Event kinds that change what a security holds; reversals and 83(b) elections do not. */
const HOLDING_EVENT_KINDS: ReadonlySet<SecurityEventKind> = new Set<SecurityEventKind>([
  "exercise",
  "settle",
  "forfeit",
  "expire",
  "cancel",
  "repurchase",
  "transfer",
  "convert",
  "void",
  "repay",
]);

/** A share-based security's state on a date, in issue units (exact) and restated whole shares. */
export interface HoldingState {
  security: SecurityRecord;
  status: HoldingStatus;
  /** Issue units → as-of units. */
  factor: Rational;
  /** Restated whole shares. */
  outstanding: bigint;
  vestedAvailable: bigint;
  unvested: bigint;
  /** Restated whole shares consumed by each event kind to date. */
  consumed: Record<
    "exercise" | "settle" | "forfeit" | "expire" | "cancel" | "repurchase" | "transfer" | "convert",
    bigint
  >;
  /** Exact issue units, for the event checks. */
  exact: {
    outstanding: Rational;
    vestedAvailable: Rational;
    unvested: Rational;
    removedUnvested: Rational;
  };
}

export function vestingTermsOf(security: SecurityRecord): VestingTerms {
  return {
    issueDate: security.issueDate,
    quantity: security.quantity ?? 0n,
    vestingStart: security.vestingStart,
    vestingMonths: security.vestingMonths,
    cliffMonths: security.cliffMonths,
    vestingFrequency: security.vestingFrequency,
    vestingTranches: security.vestingTranches,
  };
}

/** Securities voided on or before `asOf`. */
export function voidedSecurities(book: Pick<EquityBook, "events">, asOf: string): Set<string> {
  return new Set(
    book.events
      .filter((event) => event.kind === "void" && event.effectiveOn <= asOf)
      .map((event) => event.securityId),
  );
}

/** Events undone by a governed reversal effective on or before `asOf`. */
export function reversedEvents(book: Pick<EquityBook, "events">, asOf: string): Set<string> {
  return new Set(
    book.events
      .filter(
        (event) =>
          event.kind === "reverse" && event.reversesEventId !== null && event.effectiveOn <= asOf,
      )
      .map((event) => event.reversesEventId!),
  );
}

/**
 * Events of one security that change what it holds, on or before `asOf`, in
 * date then recording order. An exercise, settlement, transfer or conversion
 * whose resulting security was voided is undone from the void date: voiding
 * the certificate an event produced is how that event is corrected. An event
 * a governed reversal undid is likewise gone from the reversal date.
 */
export function eventsOf(
  book: Pick<EquityBook, "events">,
  securityId: string,
  asOf: string,
): SecurityEventRecord[] {
  const voided = voidedSecurities(book, asOf);
  const reversed = reversedEvents(book, asOf);
  return book.events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.securityId === securityId &&
        event.effectiveOn <= asOf &&
        HOLDING_EVENT_KINDS.has(event.kind) &&
        !reversed.has(event.id) &&
        !(event.resultingSecurityId !== null && voided.has(event.resultingSecurityId)),
    )
    .sort((a, b) =>
      a.event.effectiveOn < b.event.effectiveOn
        ? -1
        : a.event.effectiveOn > b.event.effectiveOn
          ? 1
          : a.index - b.index,
    )
    .map(({ event }) => event);
}

const EMPTY_CONSUMED = (): HoldingState["consumed"] => ({
  exercise: 0n,
  settle: 0n,
  forfeit: 0n,
  expire: 0n,
  cancel: 0n,
  repurchase: 0n,
  transfer: 0n,
  convert: 0n,
});

/**
 * Replay one share-based security to `asOf`. A quantity the security could
 * not have carried (an event larger than what it held) refuses by name: the
 * cap table never reads a negative position.
 */
export function holdingState(
  book: Pick<EquityBook, "events" | "splits">,
  security: SecurityRecord,
  asOf: string,
): HoldingState {
  const classId = security.shareClassId;
  if (security.quantity === null || classId === null) {
    throw equityError("securityNotShareBased", { security: fig.text(security.securityNumber) });
  }
  const factor = splitFactor(book.splits, classId, security.issueDate, asOf);
  if (asOf < security.issueDate) {
    return {
      security,
      status: "not_issued",
      factor,
      outstanding: 0n,
      vestedAvailable: 0n,
      unvested: 0n,
      consumed: EMPTY_CONSUMED(),
      exact: { outstanding: ZERO, vestedAvailable: ZERO, unvested: ZERO, removedUnvested: ZERO },
    };
  }
  const terms = vestingTermsOf(security);
  const scheduled = hasVestingSchedule(terms);
  const total = rational(security.quantity);
  let tailRemoved = ZERO;
  let vestedUsed = ZERO;
  let voided = false;
  let lastReducing: HoldingStatus | null = null;
  const consumedExact: Record<keyof HoldingState["consumed"], Rational> = {
    exercise: ZERO,
    settle: ZERO,
    forfeit: ZERO,
    expire: ZERO,
    cancel: ZERO,
    repurchase: ZERO,
    transfer: ZERO,
    convert: ZERO,
  };
  const vestedAt = (date: string): Rational => {
    const live = subtractRational(total, tailRemoved);
    const sched = scheduled ? rational(scheduledVested(terms, date)) : total;
    return minRational(sched, live);
  };
  // Units exercised early sit ahead of the vesting line: nothing is vested
  // and available until the schedule passes them.
  const availableOf = (vested: Rational): Rational =>
    compareRational(vested, vestedUsed) > 0 ? subtractRational(vested, vestedUsed) : ZERO;
  const earlyExercise = security.kind === "option" && security.earlyExercise;
  for (const event of eventsOf(book, security.id, asOf)) {
    if (event.kind === "void") {
      voided = true;
      break;
    }
    if (event.quantity === null) {
      throw equityError("holdingEventQuantityMissing", {
        security: fig.text(security.securityNumber),
      });
    }
    const issueUnits = divideRational(
      rational(event.quantity),
      splitFactor(book.splits, classId, security.issueDate, event.effectiveOn),
    );
    const live = subtractRational(total, tailRemoved);
    const vested = vestedAt(event.effectiveOn);
    const vestedAvailable = availableOf(vested);
    const unvested = subtractRational(subtractRational(live, vestedUsed), vestedAvailable);
    const over = (available: Rational): void => {
      if (compareRational(issueUnits, available) > 0) {
        throw equityError("holdingEventExceeded", {
          kind: fig.choice(event.kind),
          quantity: fig.shares(event.quantity!),
          date: fig.date(event.effectiveOn),
          security: fig.text(security.securityNumber),
        });
      }
    };
    switch (event.kind) {
      case "exercise":
        over(earlyExercise ? subtractRational(live, vestedUsed) : vestedAvailable);
        vestedUsed = addRational(vestedUsed, issueUnits);
        break;
      case "settle":
      case "expire":
      case "transfer":
      case "convert":
        over(vestedAvailable);
        vestedUsed = addRational(vestedUsed, issueUnits);
        break;
      case "forfeit":
        over(unvested);
        tailRemoved = addRational(tailRemoved, issueUnits);
        break;
      case "cancel":
      case "repurchase": {
        over(addRational(unvested, vestedAvailable));
        const fromUnvested = minRational(issueUnits, unvested);
        tailRemoved = addRational(tailRemoved, fromUnvested);
        vestedUsed = addRational(vestedUsed, subtractRational(issueUnits, fromUnvested));
        break;
      }
    }
    const kind = event.kind as keyof HoldingState["consumed"];
    consumedExact[kind] = addRational(consumedExact[kind], issueUnits);
    lastReducing = (
      {
        exercise: "exercised",
        settle: "settled",
        forfeit: "forfeited",
        expire: "expired",
        cancel: "cancelled",
        repurchase: "repurchased",
        transfer: "transferred",
        convert: "converted",
      } as const
    )[kind];
  }
  const restate = (units: Rational): bigint => floorShares(multiplyRational(units, factor));
  const consumed = EMPTY_CONSUMED();
  for (const key of Object.keys(consumed) as (keyof HoldingState["consumed"])[])
    consumed[key] = voided ? 0n : restate(consumedExact[key]);
  if (voided) {
    return {
      security,
      status: "void",
      factor,
      outstanding: 0n,
      vestedAvailable: 0n,
      unvested: 0n,
      consumed,
      exact: {
        outstanding: ZERO,
        vestedAvailable: ZERO,
        unvested: ZERO,
        removedUnvested: tailRemoved,
      },
    };
  }
  const live = subtractRational(total, tailRemoved);
  const vested = vestedAt(asOf);
  const exactOutstanding = subtractRational(live, vestedUsed);
  const exactVestedAvailable = availableOf(vested);
  const outstanding = restate(exactOutstanding);
  const restatedVested = restate(exactVestedAvailable);
  const vestedAvailable = restatedVested < outstanding ? restatedVested : outstanding;
  return {
    security,
    status: outstanding > 0n ? "outstanding" : (lastReducing ?? "outstanding"),
    factor,
    outstanding,
    vestedAvailable,
    unvested: outstanding - vestedAvailable,
    consumed,
    exact: {
      outstanding: exactOutstanding,
      vestedAvailable: exactVestedAvailable,
      unvested: subtractRational(exactOutstanding, exactVestedAvailable),
      removedUnvested: tailRemoved,
    },
  };
}

/**
 * Largest whole quantity, stated on `on`, that fits inside an exact issue-unit
 * availability: the ceiling an operator may record for an event that day.
 */
export function eventCeiling(
  book: Pick<EquityBook, "splits">,
  security: SecurityRecord,
  available: Rational,
  on: string,
): bigint {
  if (!security.shareClassId) return 0n;
  const restated = floorShares(
    multiplyRational(
      available,
      splitFactor(book.splits, security.shareClassId, security.issueDate, on),
    ),
  );
  return restated > 0n ? restated : 0n;
}

/** Authorized shares of a class on `asOf`: the latest amendment, else the initial count, restated. */
export function authorizedShares(
  book: Pick<EquityBook, "amendments" | "splits">,
  shareClass: ShareClassRecord,
  asOf: string,
): bigint {
  let base = shareClass.initialAuthorizedShares;
  let statedOn = shareClass.effectiveOn;
  for (const amendment of book.amendments) {
    if (
      amendment.shareClassId !== shareClass.id ||
      amendment.kind !== "authorized_shares" ||
      amendment.effectiveOn > asOf
    )
      continue;
    if (amendment.effectiveOn >= statedOn && amendment.authorizedShares !== null) {
      base = amendment.authorizedShares;
      statedOn = amendment.effectiveOn;
    }
  }
  return restateShares(book.splits, shareClass.id, base, statedOn, asOf);
}

/** The common class a preferred class converts into on `on`: the latest conversion-class amendment, else the class's own term. */
export function conversionClassOf(
  book: Pick<EquityBook, "amendments">,
  shareClass: ShareClassRecord,
  on: string,
): string | null {
  if (shareClass.kind !== "preferred") return null;
  let classId = shareClass.conversionShareClassId;
  let statedOn = shareClass.effectiveOn;
  for (const amendment of book.amendments) {
    if (
      amendment.shareClassId !== shareClass.id ||
      amendment.kind !== "conversion_class" ||
      amendment.effectiveOn > on
    )
      continue;
    if (amendment.effectiveOn >= statedOn && amendment.conversionShareClassId) {
      classId = amendment.conversionShareClassId;
      statedOn = amendment.effectiveOn;
    }
  }
  return classId;
}

/**
 * Product of the ratios of the conversion-class splits that adjust a
 * preferred class's conversion price after `after` and on or before
 * `through`: each split counts when, on its date, the class converts into
 * the split class and its terms adjust for splits.
 */
export function conversionSplitFactor(
  book: Pick<EquityBook, "amendments" | "splits">,
  shareClass: ShareClassRecord,
  after: string,
  through: string,
): Rational {
  if (shareClass.kind !== "preferred" || !shareClass.conversionAdjustsForSplits) return ONE;
  let factor = ONE;
  for (const split of book.splits) {
    if (
      split.effectiveOn <= after ||
      split.effectiveOn > through ||
      split.shareClassId === shareClass.id
    )
      continue;
    if (conversionClassOf(book, shareClass, split.effectiveOn) !== split.shareClassId) continue;
    factor = multiplyRational(factor, rational(split.ratioNumerator, split.ratioDenominator));
  }
  return factor;
}

/**
 * A preferred class's conversion price on `asOf` (exact): the latest
 * amendment, restated through the class's own splits and divided by every
 * adjusting split of its conversion class since it was stated.
 */
export function conversionPrice(
  book: Pick<EquityBook, "amendments" | "splits">,
  shareClass: ShareClassRecord,
  asOf: string,
): Rational | null {
  if (shareClass.kind !== "preferred" || !shareClass.initialConversionPrice) return null;
  let price = parsePrice(shareClass.initialConversionPrice, "conversionPrice");
  let statedOn = shareClass.effectiveOn;
  for (const amendment of book.amendments) {
    if (
      amendment.shareClassId !== shareClass.id ||
      amendment.kind !== "conversion_price" ||
      amendment.effectiveOn > asOf
    )
      continue;
    if (amendment.effectiveOn >= statedOn && amendment.conversionPrice) {
      price = parsePrice(amendment.conversionPrice, "conversionPrice");
      statedOn = amendment.effectiveOn;
    }
  }
  return divideRational(
    restatePrice(book.splits, shareClass.id, price, statedOn, asOf),
    conversionSplitFactor(book, shareClass, statedOn, asOf),
  );
}

/** Original issue price of a preferred class on `asOf`, restated through its splits. */
export function originalIssuePrice(
  book: Pick<EquityBook, "splits">,
  shareClass: ShareClassRecord,
  asOf: string,
): Rational | null {
  if (!shareClass.originalIssuePrice) return null;
  return restatePrice(
    book.splits,
    shareClass.id,
    parsePrice(shareClass.originalIssuePrice, "originalIssuePrice"),
    shareClass.effectiveOn,
    asOf,
  );
}

/** Common shares one share of the class converts into on `asOf` (1 for common). */
export function conversionRatio(
  book: Pick<EquityBook, "amendments" | "splits">,
  shareClass: ShareClassRecord,
  asOf: string,
): Rational {
  if (shareClass.kind === "common") return ONE;
  const issue = originalIssuePrice(book, shareClass, asOf);
  const price = conversionPrice(book, shareClass, asOf);
  if (!issue || !price || price.numerator <= 0n) {
    throw equityError("classConversionTermsMissing", {
      code: fig.text(shareClass.code),
      issuePrice: fig.term("originalIssuePrice"),
      conversionPrice: fig.term("conversionPrice"),
    });
  }
  return divideRational(issue, price);
}

export interface PlanPool {
  plan: PlanRecord;
  reserved: bigint;
  /** Awards granted from the plan and not returned to it, restated. */
  used: bigint;
  returned: bigint;
  available: bigint;
}

/** Event kinds that return an award's units to its plan, per the plan's recycling flags. */
function returnsToPlan(
  plan: PlanRecord,
  kind: SecurityEventRecord["kind"],
  fromPlanAward: boolean,
): boolean {
  if (fromPlanAward) {
    if (kind === "forfeit" || kind === "cancel") return plan.recycleForfeited;
    if (kind === "expire") return plan.recycleExpired;
    return false;
  }
  return kind === "repurchase" && plan.recycleRepurchased;
}

/**
 * Pool availability of a plan on `asOf`: the reserve (initial plus dated
 * changes) less awards granted, plus units returned under the recycling
 * flags — forfeited and cancelled awards, expired options, and repurchased
 * shares that came from the plan's awards. Every term is restated to the
 * as-of date exactly and the availability is rounded down once.
 */
export function planPool(book: EquityBook, plan: PlanRecord, asOf: string): PlanPool {
  const classId = plan.shareClassId;
  const exact = (quantity: bigint, statedOn: string): Rational =>
    multiplyRational(rational(quantity), splitFactor(book.splits, classId, statedOn, asOf));
  let reserved =
    asOf >= plan.effectiveOn ? exact(plan.initialReservedShares, plan.effectiveOn) : ZERO;
  for (const change of book.reserveChanges) {
    if (change.planId === plan.id && change.effectiveOn <= asOf)
      reserved = addRational(reserved, exact(change.shareDelta, change.effectiveOn));
  }
  const awards = new Set<string>();
  let granted = ZERO;
  for (const security of book.securities) {
    if (security.planId !== plan.id || security.quantity === null || security.issueDate > asOf)
      continue;
    awards.add(security.id);
    granted = addRational(granted, exact(security.quantity, security.issueDate));
  }
  // Shares an award became (exercise or settlement certificates) repurchase back into the plan.
  const fromAward = new Set<string>();
  for (const security of book.securities) {
    if (
      security.sourceSecurityId &&
      awards.has(security.sourceSecurityId) &&
      security.kind === "share"
    )
      fromAward.add(security.id);
  }
  let returned = ZERO;
  const reversed = reversedEvents(book, asOf);
  const voidedAwards = new Set<string>();
  for (const event of book.events) {
    if (event.effectiveOn > asOf) continue;
    if (event.kind === "void" && awards.has(event.securityId)) voidedAwards.add(event.securityId);
  }
  for (const event of book.events) {
    if (event.effectiveOn > asOf || event.quantity === null || reversed.has(event.id)) continue;
    const award = awards.has(event.securityId) && !voidedAwards.has(event.securityId);
    const certificate = fromAward.has(event.securityId);
    if (!award && !certificate) continue;
    if (returnsToPlan(plan, event.kind, award))
      returned = addRational(returned, exact(event.quantity, event.effectiveOn));
  }
  // A voided award never drew on the pool.
  for (const security of book.securities) {
    if (voidedAwards.has(security.id) && security.quantity !== null) {
      granted = subtractRational(granted, exact(security.quantity, security.issueDate));
    }
  }
  const used = subtractRational(granted, returned);
  return {
    plan,
    reserved: floorShares(reserved),
    used: floorShares(used),
    returned: floorShares(returned),
    available: floorShares(subtractRational(reserved, used)),
  };
}

export type ConvertibleStatus =
  "outstanding" | "converted" | "repaid" | "cancelled" | "void" | "not_issued";

export interface ConvertibleState {
  security: SecurityRecord;
  status: ConvertibleStatus;
  principal: string;
  accruedInterest: string;
  convertingAmount: string;
  /** The date the instrument converted, was repaid, cancelled or voided. */
  endedOn: string | null;
  convertedOn: string | null;
  resultingSecurityId: string | null;
  /** The terms in force on the date: the stated terms, or those an MFN election adopted. */
  terms: ConvertibleTerms;
  /** The MFN election the terms come from, if any. */
  electionId: string | null;
}

/** A SAFE's or note's terms as issued. */
export function convertibleTerms(security: SecurityRecord): ConvertibleTerms {
  if (security.kind !== "safe" && security.kind !== "note") {
    throw equityError("securityNotConvertible", { security: fig.text(security.securityNumber) });
  }
  return {
    id: security.id,
    kind: security.kind,
    issueDate: security.issueDate,
    principal: security.considerationAmount ?? "",
    safeType: security.safeType,
    valuationCap: security.valuationCap,
    discountPercent: security.discountPercent,
    interestRatePercent: security.interestRatePercent,
    interestBasis: security.interestBasis,
    interestDayCount: security.interestDayCount,
    currency: security.currency,
  };
}

/** MFN elections undone by a recorded reversal effective on or before `asOf`. */
export function reversedElections(
  book: Pick<EquityBook, "securityAmendments">,
  asOf: string,
): Set<string> {
  return new Set(
    book.securityAmendments
      .filter(
        (row) =>
          row.kind === "mfn_reversal" &&
          row.reversesAmendmentId !== null &&
          row.effectiveOn <= asOf,
      )
      .map((row) => row.reversesAmendmentId!),
  );
}

/**
 * The MFN election in force for a SAFE on `asOf`: its latest election
 * effective by then that no reversal has undone. An election whose source
 * instrument is void names terms that were entered in error, so it never
 * applies, whatever the void's date: a conversion always uses terms that
 * stand. `includeVoidedSources` reads the elections as recorded, to find
 * conversions that relied on such terms.
 */
export function electionInForce(
  book: Pick<EquityBook, "securityAmendments" | "events">,
  security: SecurityRecord,
  asOf: string,
  options: { includeVoidedSources?: boolean } = {},
): EquityBook["securityAmendments"][number] | null {
  const reversed = reversedElections(book, asOf);
  const voided = options.includeVoidedSources
    ? new Set<string>()
    : voidedSecurities(book, "9999-12-31");
  let election: EquityBook["securityAmendments"][number] | null = null;
  for (const amendment of book.securityAmendments) {
    if (
      amendment.securityId !== security.id ||
      amendment.kind !== "mfn_election" ||
      amendment.effectiveOn > asOf
    )
      continue;
    if (reversed.has(amendment.id) || voided.has(amendment.sourceSecurityId)) continue;
    if (!election || amendment.effectiveOn >= election.effectiveOn) election = amendment;
  }
  return election;
}

/**
 * An MFN election in force on `on` whose adopted terms came from an
 * instrument that is void (whenever the void is dated), and whose terms
 * differ from those the SAFE carries without it. A conversion on that date
 * must not proceed until the election is reversed, and a conversion
 * recorded while it stood is flagged by conversionOnVoidedTerms.
 */
export function electionOnVoidedSource(
  book: Pick<EquityBook, "securityAmendments" | "events">,
  security: SecurityRecord,
  on: string,
  asOf = "9999-12-31",
): { election: EquityBook["securityAmendments"][number]; sourceVoidedOn: string } | null {
  if (security.kind !== "safe") return null;
  const election = electionInForce(book, security, on, { includeVoidedSources: true });
  if (!election) return null;
  const voided = book.events.find(
    (event) =>
      event.kind === "void" &&
      event.securityId === election.sourceSecurityId &&
      event.effectiveOn <= asOf,
  );
  if (!voided) return null;
  const { terms: standing } = effectiveConvertibleTerms(book, security, on);
  const same = (a: string | null, b: string | null) =>
    a === null || b === null
      ? a === b
      : compareRational(parseMoney(a, "convertibleTerm"), parseMoney(b, "convertibleTerm")) === 0;
  if (
    same(standing.valuationCap, election.valuationCap) &&
    same(standing.discountPercent, election.discountPercent) &&
    (standing.safeType ?? "pre_money") === election.safeType
  )
    return null;
  return { election, sourceVoidedOn: voided.effectiveOn };
}

/**
 * A conversion recorded on terms an MFN election adopted from an instrument
 * that is void: voided on or before the conversion date (a conversion
 * recorded before conversions were held back from such terms) or after it.
 * Either way the terms no longer stand, so the conversion is corrected by
 * voiding the certificate it produced, reversing the election and
 * converting again. Null for any conversion on terms that stand.
 */
export function conversionOnVoidedTerms(
  book: Pick<EquityBook, "securityAmendments" | "events">,
  security: SecurityRecord,
  asOf: string,
): {
  electionId: string;
  sourceSecurityId: string;
  sourceVoidedOn: string;
  resultingSecurityId: string | null;
} | null {
  if (security.kind !== "safe") return null;
  const conversion = eventsOf(book, security.id, asOf).find((event) => event.kind === "convert");
  if (!conversion) return null;
  const relied = electionOnVoidedSource(book, security, conversion.effectiveOn, asOf);
  if (!relied) return null;
  return {
    electionId: relied.election.id,
    sourceSecurityId: relied.election.sourceSecurityId,
    sourceVoidedOn: relied.sourceVoidedOn,
    resultingSecurityId: conversion.resultingSecurityId,
  };
}

/**
 * The terms in force on `asOf`: an MFN SAFE carries the cap, discount and
 * SAFE type of its election in force then (see electionInForce); otherwise
 * the terms as issued. `includeVoidedSources` reads the terms as recorded,
 * an election adopting a since-voided instrument's terms included.
 */
export function effectiveConvertibleTerms(
  book: Pick<EquityBook, "securityAmendments" | "events">,
  security: SecurityRecord,
  asOf: string,
  options: { includeVoidedSources?: boolean } = {},
): { terms: ConvertibleTerms; electionId: string | null } {
  const terms = convertibleTerms(security);
  const election = electionInForce(book, security, asOf, options);
  if (!election) return { terms, electionId: null };
  return {
    terms: {
      ...terms,
      valuationCap: election.valuationCap,
      discountPercent: election.discountPercent,
      safeType: election.safeType,
    },
    electionId: election.id,
  };
}

/** Event kinds that end a SAFE or note. */
const CONVERTIBLE_ENDINGS: Readonly<Partial<Record<SecurityEventKind, ConvertibleStatus>>> = {
  void: "void",
  convert: "converted",
  repay: "repaid",
  cancel: "cancelled",
};

export function convertibleState(
  book: Pick<EquityBook, "events" | "securityAmendments">,
  security: SecurityRecord,
  asOf: string,
): ConvertibleState {
  const { terms, electionId } = effectiveConvertibleTerms(book, security, asOf);
  const principal = parseMoney(terms.principal, "principal");
  if (asOf < security.issueDate) {
    return {
      security,
      status: "not_issued",
      principal: formatMoney(principal),
      accruedInterest: "0.0000",
      convertingAmount: formatMoney(principal),
      endedOn: null,
      convertedOn: null,
      resultingSecurityId: null,
      terms,
      electionId,
    };
  }
  const ended = eventsOf(book, security.id, asOf).find(
    (event) => CONVERTIBLE_ENDINGS[event.kind] !== undefined,
  );
  const until = ended?.effectiveOn ?? asOf;
  const interest = accruedInterest(terms, until);
  return {
    security,
    status: ended ? CONVERTIBLE_ENDINGS[ended.kind]! : "outstanding",
    principal: formatMoney(principal),
    accruedInterest: formatMoney(interest),
    convertingAmount: formatMoney(addRational(principal, interest)),
    endedOn: ended?.effectiveOn ?? null,
    convertedOn: ended?.kind === "convert" ? ended.effectiveOn : null,
    resultingSecurityId: ended?.kind === "convert" ? ended.resultingSecurityId : null,
    terms,
    electionId,
  };
}

export interface HoldingRow {
  securityId: string;
  securityNumber: string;
  kind: SecurityRecord["kind"];
  holderPartyId: string;
  shareClassId: string;
  planId: string | null;
  status: HoldingStatus;
  outstanding: string;
  vested: string;
  unvested: string;
  asConverted: string;
  /** Exercise price per share restated to the as-of date (options and warrants). */
  exercisePrice: string | null;
}

export interface ClassRow {
  shareClassId: string;
  code: string;
  name: string;
  kind: ShareClassRecord["kind"];
  seniority: number;
  authorized: string;
  outstanding: string;
  asConvertedOutstanding: string;
  awardsOutstanding: string;
  poolAvailable: string;
  fullyDiluted: string;
  conversionRatio: string;
  parValue: string;
  originalIssuePrice: string | null;
  conversionPrice: string | null;
  outstandingPercent: string;
  fullyDilutedPercent: string;
}

export interface HolderRow {
  holderPartyId: string;
  /** Issued shares by class id (restated whole shares). */
  sharesByClass: Record<string, string>;
  asConvertedOutstanding: string;
  options: string;
  rsus: string;
  warrants: string;
  vestedAwards: string;
  fullyDiluted: string;
  outstandingPercent: string;
  fullyDilutedPercent: string;
}

export interface PlanRow {
  planId: string;
  code: string;
  name: string;
  shareClassId: string;
  reserved: string;
  used: string;
  returned: string;
  available: string;
  awardsOutstanding: string;
}

export interface ConvertibleRow {
  securityId: string;
  securityNumber: string;
  kind: "safe" | "note";
  holderPartyId: string;
  status: ConvertibleState["status"];
  principal: string;
  /** Principal still outstanding on the date: the principal while outstanding, zero once converted, repaid, cancelled or void. */
  outstandingPrincipal: string;
  accruedInterest: string;
  convertingAmount: string;
  /** The share certificate a conversion produced. */
  resultingSecurityId: string | null;
  /** Terms in force on the as-of date (an MFN election's adopted terms when one applies). */
  valuationCap: string | null;
  discountPercent: string | null;
  safeType: SecurityRecord["safeType"];
  mfn: boolean;
  electionId: string | null;
  currency: string;
}

/** The unallocated plan pools on the holder basis: no holder owns them, but they count toward fully diluted. */
export interface UnallocatedPoolRow {
  /** Unallocated pool shares, as converted into common. */
  fullyDiluted: string;
  fullyDilutedPercent: string;
}

export interface CapTable {
  asOf: string;
  classes: ClassRow[];
  holders: HolderRow[];
  /** The holder basis's line for the unallocated pools, so holders and the pool sum to the fully diluted total. */
  unallocatedPool: UnallocatedPoolRow;
  plans: PlanRow[];
  holdings: HoldingRow[];
  convertibles: ConvertibleRow[];
  totals: {
    outstanding: string;
    asConvertedOutstanding: string;
    awardsOutstanding: string;
    poolAvailable: string;
    fullyDiluted: string;
  };
}

/** Fully diluted counts by holder and class, as the round model and waterfall consume them. */
export interface CapitalizationCounts {
  asConvertedOutstanding: bigint;
  awardsOutstanding: bigint;
  poolAvailable: bigint;
  fullyDiluted: bigint;
  byHolder: Map<string, bigint>;
}

const percentOf = (part: bigint, whole: bigint): string =>
  whole > 0n ? formatPercent(rational(part, whole)) : "0.0000";

/** Build the cap table of a legal entity as of a date. */
export function buildCapTable(book: EquityBook, asOf: string): CapTable {
  const classById = new Map(book.classes.map((shareClass) => [shareClass.id, shareClass]));
  const ratios = new Map<string, Rational>();
  const ratioOf = (classId: string): Rational => {
    let ratio = ratios.get(classId);
    if (!ratio) {
      const shareClass = classById.get(classId);
      if (!shareClass) throw equityError("classReferenceUnknown", {}, { status: 422 });
      ratio = conversionRatio(book, shareClass, asOf);
      ratios.set(classId, ratio);
    }
    return ratio;
  };
  const holdings: HoldingRow[] = [];
  const convertibles: ConvertibleRow[] = [];
  const classTotals = new Map<
    string,
    { outstanding: bigint; asConverted: bigint; awards: bigint; awardsAsConverted: bigint }
  >();
  const holderTotals = new Map<
    string,
    {
      byClass: Map<string, bigint>;
      asConverted: bigint;
      options: bigint;
      rsus: bigint;
      warrants: bigint;
      vestedAwards: bigint;
      awardsAsConverted: bigint;
    }
  >();
  const planAwards = new Map<string, bigint>();
  const holderOf = (partyId: string) => {
    let row = holderTotals.get(partyId);
    if (!row) {
      row = {
        byClass: new Map(),
        asConverted: 0n,
        options: 0n,
        rsus: 0n,
        warrants: 0n,
        vestedAwards: 0n,
        awardsAsConverted: 0n,
      };
      holderTotals.set(partyId, row);
    }
    return row;
  };
  const classOf = (classId: string) => {
    let row = classTotals.get(classId);
    if (!row) {
      row = { outstanding: 0n, asConverted: 0n, awards: 0n, awardsAsConverted: 0n };
      classTotals.set(classId, row);
    }
    return row;
  };
  for (const security of book.securities) {
    if (security.issueDate > asOf) continue;
    if (security.kind === "safe" || security.kind === "note") {
      const state = convertibleState(book, security, asOf);
      convertibles.push({
        securityId: security.id,
        securityNumber: security.securityNumber,
        kind: security.kind,
        holderPartyId: security.holderPartyId,
        status: state.status,
        principal: state.principal,
        outstandingPrincipal: state.status === "outstanding" ? state.principal : "0.0000",
        accruedInterest: state.accruedInterest,
        convertingAmount: state.convertingAmount,
        resultingSecurityId: state.resultingSecurityId,
        valuationCap: state.terms.valuationCap,
        discountPercent: state.terms.discountPercent,
        safeType: state.terms.safeType,
        mfn: security.mfn,
        electionId: state.electionId,
        currency: security.currency,
      });
      continue;
    }
    const state = holdingState(book, security, asOf);
    const classId = security.shareClassId!;
    const asConverted = floorShares(
      multiplyRational(rational(state.outstanding), ratioOf(classId)),
    );
    const exercisePrice =
      (security.kind === "option" || security.kind === "warrant") && security.pricePerShare
        ? formatPrice(
            restatePrice(
              book.splits,
              classId,
              parsePrice(security.pricePerShare, "exercisePrice"),
              security.issueDate,
              asOf,
            ),
          )
        : null;
    holdings.push({
      securityId: security.id,
      securityNumber: security.securityNumber,
      kind: security.kind,
      holderPartyId: security.holderPartyId,
      shareClassId: classId,
      planId: security.planId,
      status: state.status,
      outstanding: state.outstanding.toString(),
      vested: state.vestedAvailable.toString(),
      unvested: state.unvested.toString(),
      asConverted: asConverted.toString(),
      exercisePrice,
    });
    if (state.outstanding === 0n) continue;
    const classRow = classOf(classId);
    const holder = holderOf(security.holderPartyId);
    if (security.kind === "share") {
      classRow.outstanding += state.outstanding;
      classRow.asConverted += asConverted;
      holder.byClass.set(classId, (holder.byClass.get(classId) ?? 0n) + state.outstanding);
      holder.asConverted += asConverted;
    } else {
      classRow.awards += state.outstanding;
      classRow.awardsAsConverted += asConverted;
      holder.awardsAsConverted += asConverted;
      holder.vestedAwards += state.vestedAvailable;
      if (security.kind === "option") holder.options += state.outstanding;
      else if (security.kind === "rsu") holder.rsus += state.outstanding;
      else holder.warrants += state.outstanding;
      if (security.planId)
        planAwards.set(
          security.planId,
          (planAwards.get(security.planId) ?? 0n) + state.outstanding,
        );
    }
  }
  const plans: PlanRow[] = [];
  const poolByClass = new Map<string, bigint>();
  let poolTotal = 0n;
  for (const plan of book.plans) {
    if (plan.effectiveOn > asOf) continue;
    const pool = planPool(book, plan, asOf);
    const available = pool.available > 0n ? pool.available : 0n;
    const poolAsConverted = floorShares(
      multiplyRational(rational(available), ratioOf(plan.shareClassId)),
    );
    poolByClass.set(
      plan.shareClassId,
      (poolByClass.get(plan.shareClassId) ?? 0n) + poolAsConverted,
    );
    poolTotal += poolAsConverted;
    plans.push({
      planId: plan.id,
      code: plan.code,
      name: plan.name,
      shareClassId: plan.shareClassId,
      reserved: pool.reserved.toString(),
      used: pool.used.toString(),
      returned: pool.returned.toString(),
      available: pool.available.toString(),
      awardsOutstanding: (planAwards.get(plan.id) ?? 0n).toString(),
    });
  }
  let outstandingTotal = 0n;
  let asConvertedTotal = 0n;
  let awardsTotal = 0n;
  for (const row of classTotals.values()) {
    outstandingTotal += row.outstanding;
    asConvertedTotal += row.asConverted;
    awardsTotal += row.awardsAsConverted;
  }
  const fullyDilutedTotal = asConvertedTotal + awardsTotal + poolTotal;
  const classes: ClassRow[] = book.classes
    .filter((shareClass) => shareClass.effectiveOn <= asOf)
    .map((shareClass) => {
      const row = classTotals.get(shareClass.id) ?? {
        outstanding: 0n,
        asConverted: 0n,
        awards: 0n,
        awardsAsConverted: 0n,
      };
      const pool = poolByClass.get(shareClass.id) ?? 0n;
      const fullyDiluted = row.asConverted + row.awardsAsConverted + pool;
      const issue = originalIssuePrice(book, shareClass, asOf);
      const price = conversionPrice(book, shareClass, asOf);
      return {
        shareClassId: shareClass.id,
        code: shareClass.code,
        name: shareClass.name,
        kind: shareClass.kind,
        seniority: shareClass.seniority,
        authorized: authorizedShares(book, shareClass, asOf).toString(),
        outstanding: row.outstanding.toString(),
        asConvertedOutstanding: row.asConverted.toString(),
        awardsOutstanding: row.awards.toString(),
        poolAvailable: pool.toString(),
        fullyDiluted: fullyDiluted.toString(),
        conversionRatio: formatPrice(ratioOf(shareClass.id)),
        parValue: formatPrice(
          restatePrice(
            book.splits,
            shareClass.id,
            parsePrice(shareClass.parValue, "parValue"),
            shareClass.effectiveOn,
            asOf,
          ),
        ),
        originalIssuePrice: issue ? formatPrice(issue) : null,
        conversionPrice: price ? formatPrice(price) : null,
        outstandingPercent: percentOf(row.asConverted, asConvertedTotal),
        fullyDilutedPercent: percentOf(fullyDiluted, fullyDilutedTotal),
      };
    });
  const holders: HolderRow[] = [...holderTotals.entries()]
    .map(([holderPartyId, row]) => {
      const fullyDiluted = row.asConverted + row.awardsAsConverted;
      return {
        holderPartyId,
        sharesByClass: Object.fromEntries(
          [...row.byClass.entries()].map(([classId, shares]) => [classId, shares.toString()]),
        ),
        asConvertedOutstanding: row.asConverted.toString(),
        options: row.options.toString(),
        rsus: row.rsus.toString(),
        warrants: row.warrants.toString(),
        vestedAwards: row.vestedAwards.toString(),
        fullyDiluted: fullyDiluted.toString(),
        outstandingPercent: percentOf(row.asConverted, asConvertedTotal),
        fullyDilutedPercent: percentOf(fullyDiluted, fullyDilutedTotal),
      };
    })
    .sort(
      (a, b) =>
        compareBig(BigInt(b.fullyDiluted), BigInt(a.fullyDiluted)) ||
        (a.holderPartyId < b.holderPartyId ? -1 : 1),
    );
  return {
    asOf,
    classes,
    holders,
    unallocatedPool: {
      fullyDiluted: poolTotal.toString(),
      fullyDilutedPercent: percentOf(poolTotal, fullyDilutedTotal),
    },
    plans,
    holdings,
    convertibles,
    totals: {
      outstanding: outstandingTotal.toString(),
      asConvertedOutstanding: asConvertedTotal.toString(),
      awardsOutstanding: awardsTotal.toString(),
      poolAvailable: poolTotal.toString(),
      fullyDiluted: fullyDilutedTotal.toString(),
    },
  };
}

function compareBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Fully diluted counts as bigints, for the round model and waterfall. */
export function capitalizationCounts(table: CapTable): CapitalizationCounts {
  return {
    asConvertedOutstanding: BigInt(table.totals.asConvertedOutstanding),
    awardsOutstanding: BigInt(table.totals.awardsOutstanding),
    poolAvailable: BigInt(table.totals.poolAvailable),
    fullyDiluted: BigInt(table.totals.fullyDiluted),
    byHolder: new Map(
      table.holders.map((holder) => [holder.holderPartyId, BigInt(holder.fullyDiluted)]),
    ),
  };
}

/** Outstanding issued shares of one class on `asOf` (restated whole shares). */
export function classOutstanding(book: EquityBook, shareClassId: string, asOf: string): bigint {
  let total = 0n;
  for (const security of book.securities) {
    if (
      security.kind !== "share" ||
      security.shareClassId !== shareClassId ||
      security.issueDate > asOf
    )
      continue;
    total += holdingState(book, security, asOf).outstanding;
  }
  return total;
}

/** Shares a class must keep available: outstanding shares, outstanding awards and unallocated plan pools. */
export function classCommitted(book: EquityBook, shareClassId: string, asOf: string): bigint {
  let total = 0n;
  for (const security of book.securities) {
    if (
      security.shareClassId !== shareClassId ||
      security.issueDate > asOf ||
      security.quantity === null
    )
      continue;
    total += holdingState(book, security, asOf).outstanding;
  }
  for (const plan of book.plans) {
    if (plan.shareClassId !== shareClassId || plan.effectiveOn > asOf) continue;
    const available = planPool(book, plan, asOf).available;
    if (available > 0n) total += available;
  }
  return total;
}
