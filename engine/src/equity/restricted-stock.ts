/**
 * Restricted stock: shares that vest after they are issued, whether bought
 * outright (founder stock) or by exercising an option before it vests.
 *
 * Early exercise. An option that admits it may be exercised beyond its
 * vested units. The exercise takes the option's vested units first, then
 * its earliest unvested installments, and issues one certificate whose
 * schedule repeats those installments: units vested at exercise vest on the
 * exercise date, the rest on the option's own installment dates. The
 * company may repurchase unvested shares, at cost or at the lower of cost
 * and fair market value as the grant states, until they vest.
 *
 * Accounting. Cash paid for unvested shares is a deposit, not share
 * capital: the exercise credits it to the early-exercise deposit account.
 * As the shares vest, the stock compensation run releases the deposit for
 * the vested units to equity together with the grant-date value of those
 * units (Dr deposit, Dr paid-in capital (share-based) / Cr share capital at
 * par, Cr APIC). Deposits are measured on a front-to-back basis: the
 * deposit for units [a, b) of the restricted portion is
 * round(price × (vested + b)) − round(price × (vested + a)), so releases
 * from the front and repurchases from the back always sum to the cash
 * received. A foreign-currency deposit keeps the exercise-date rate.
 *
 * 83(b) elections. A holder of restricted stock may elect, within 30 days
 * of the issue, to be taxed on the shares at issue; the election's filing
 * date is recorded on the certificate and the deadline is reported.
 */
import { addCalendarDays, calendarDaysBetween } from "../platform/civil-date.ts";
import { holdingState, reversedEvents, vestingTermsOf } from "./cap-table.ts";
import { functionalUnits, restate } from "./fx.ts";
import {
  addRational,
  compareRational,
  divideRational,
  floorShares,
  ledgerUnits,
  minRational,
  multiplyRational,
  parsePrice,
  rational,
  subtractRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import { restatePrice, splitFactor } from "./splits.ts";
import type { EquityBook, SecurityRecord, ShareClassRecord, VestingTranche } from "./types.ts";
import { hasVestingSchedule, scheduledVested, vestingInstallments } from "./vesting.ts";

/** The 83(b) filing window, in days from the issue date. */
export const ELECTION_83B_DAYS = 30;

const maxRational = (a: Rational, b: Rational): Rational => (compareRational(a, b) >= 0 ? a : b);

/**
 * The schedule of the certificate an early exercise of `units` (stated on
 * `on`) issues, and how many of its shares are vested on issue. Null when
 * every exercised unit is already vested.
 */
export function earlyExerciseSchedule(
  book: EquityBook,
  option: SecurityRecord,
  units: bigint,
  on: string,
): { tranches: VestingTranche[]; vestedOnIssue: bigint } | null {
  const terms = vestingTermsOf(option);
  if (!hasVestingSchedule(terms) || !option.shareClassId || option.quantity === null) return null;
  const state = holdingState(book, option, on);
  const live = subtractRational(rational(option.quantity), state.exact.removedUnvested);
  const used = subtractRational(live, state.exact.outstanding);
  const factor = splitFactor(book.splits, option.shareClassId, option.issueDate, on);
  const exercised = divideRational(rational(units), factor);
  if (compareRational(exercised, state.exact.vestedAvailable) <= 0) return null;
  const end = used;
  const stop = addRational(end, exercised);
  const portions: { date: string; end: Rational }[] = [];
  for (const installment of vestingInstallments(terms)) {
    const start = rational(installment.cumulative - installment.quantity);
    const finish = rational(installment.cumulative);
    const lo = maxRational(start, end);
    const hi = minRational(finish, stop);
    if (compareRational(hi, lo) <= 0) continue;
    portions.push({
      date: installment.date <= on ? on : installment.date,
      end: subtractRational(hi, end),
    });
  }
  const tranches: VestingTranche[] = [];
  let previous = 0n;
  portions.forEach((portion, index) => {
    const cumulative =
      index === portions.length - 1 ? units : floorShares(multiplyRational(portion.end, factor));
    const quantity = cumulative - previous;
    previous = cumulative;
    if (quantity <= 0n) return;
    const last = tranches[tranches.length - 1];
    if (last && last.date === portion.date) last.quantity += quantity;
    else tranches.push({ date: portion.date, quantity });
  });
  const vestedOnIssue = tranches[0]?.date === on ? tranches[0].quantity : 0n;
  return { tranches, vestedOnIssue };
}

/** The option an early-exercise certificate came from, or null for any other security. */
export function earlyExerciseSource(
  book: Pick<EquityBook, "securities" | "events">,
  certificate: SecurityRecord,
): SecurityRecord | null {
  if (certificate.kind !== "share" || !certificate.vestingTranches || !certificate.sourceSecurityId)
    return null;
  const option = book.securities.find((row) => row.id === certificate.sourceSecurityId);
  if (!option || option.kind !== "option") return null;
  const exercised = book.events.some(
    (event) =>
      event.kind === "exercise" &&
      event.securityId === option.id &&
      event.resultingSecurityId === certificate.id,
  );
  return exercised ? option : null;
}

/** Shares of a restricted certificate vested on issue, and its restricted remainder. */
export function restrictedPortion(certificate: SecurityRecord): {
  vestedOnIssue: bigint;
  restricted: bigint;
} {
  const quantity = certificate.quantity ?? 0n;
  const first = certificate.vestingTranches?.[0];
  const vestedOnIssue = first && first.date === certificate.issueDate ? first.quantity : 0n;
  return { vestedOnIssue, restricted: quantity - vestedOnIssue };
}

/** Restricted units (issue units) of a certificate that have vested and are still held on `through`. */
export function releasedUnits(
  book: EquityBook,
  certificate: SecurityRecord,
  through: string,
): Rational {
  if (through < certificate.issueDate) return ZERO;
  const state = holdingState(book, certificate, through);
  if (state.status === "void") return ZERO;
  const { vestedOnIssue } = restrictedPortion(certificate);
  const live = subtractRational(rational(certificate.quantity ?? 0n), state.exact.removedUnvested);
  const vested = minRational(rational(scheduledVested(vestingTermsOf(certificate), through)), live);
  const released = subtractRational(vested, rational(vestedOnIssue));
  return compareRational(released, ZERO) > 0 ? released : ZERO;
}

/** Functional deposit for restricted units [from, to) at the exercise-date rate. */
export function depositSlice(
  certificate: SecurityRecord,
  from: Rational,
  to: Rational,
  exponent: number,
): bigint {
  const { vestedOnIssue } = restrictedPortion(certificate);
  const price = parsePrice(certificate.pricePerShare ?? "0", "exercisePrice");
  const at = (count: Rational): bigint =>
    functionalUnits(
      ledgerUnits(multiplyRational(price, addRational(rational(vestedOnIssue), count)), exponent),
      certificate.fxRate,
    );
  return at(to) - at(from);
}

/**
 * The deposit a certificate's vesting leaves held on `asOf`, in functional
 * ledger units: the cash paid for its restricted units that have not vested
 * and are still held (releases come from the front of the restricted
 * portion, repurchases from the back). Zero before issue and once void.
 */
export function unreleasedDeposit(
  book: EquityBook,
  certificate: SecurityRecord,
  asOf: string,
  exponent: number,
): bigint {
  if (asOf < certificate.issueDate) return 0n;
  const state = holdingState(book, certificate, asOf);
  if (state.status === "void") return 0n;
  const held = subtractRational(
    rational(restrictedPortion(certificate).restricted),
    state.exact.removedUnvested,
  );
  const released = releasedUnits(book, certificate, asOf);
  if (compareRational(held, released) <= 0) return 0n;
  return depositSlice(certificate, released, held, exponent);
}

export interface ReleaseMeasure {
  securityId: string;
  /** Restricted units released to date, whole shares (rounded down). */
  shares: bigint;
  /** Cumulative functional ledger units released. */
  deposit: bigint;
  reclass: bigint;
  par: bigint;
}

/** What the run has released for a certificate through `through`: deposit, grant-date value and par of its vested restricted units. */
export function measureRelease(
  book: EquityBook,
  certificate: SecurityRecord,
  option: SecurityRecord,
  shareClass: ShareClassRecord,
  through: string,
  exponents: { certificate: number; functional: number },
): ReleaseMeasure {
  const released = releasedUnits(book, certificate, through);
  const deposit = depositSlice(certificate, ZERO, released, exponents.certificate);
  const toOption = splitFactor(book.splits, shareClass.id, option.issueDate, certificate.issueDate);
  const fairValue = option.fairValuePerUnit
    ? parsePrice(option.fairValuePerUnit, "fairValuePerUnit")
    : ZERO;
  const reclass = ledgerUnits(
    restate(multiplyRational(divideRational(released, toOption), fairValue), option.fxRate),
    exponents.functional,
  );
  const parValue = restatePrice(
    book.splits,
    shareClass.id,
    parsePrice(shareClass.parValue, "parValue"),
    shareClass.effectiveOn,
    certificate.issueDate,
  );
  const par = ledgerUnits(multiplyRational(parValue, released), exponents.functional);
  return { securityId: certificate.id, shares: floorShares(released), deposit, reclass, par };
}

/** Restricted units [from, to) a repurchase of `units` (stated on `on`) takes from the back of the restricted portion. */
export function repurchasedRange(
  book: EquityBook,
  certificate: SecurityRecord,
  units: bigint,
  on: string,
): { from: Rational; to: Rational } {
  const state = holdingState(book, certificate, on);
  const { restricted } = restrictedPortion(certificate);
  const issueUnits = divideRational(
    rational(units),
    splitFactor(book.splits, certificate.shareClassId!, certificate.issueDate, on),
  );
  const to = subtractRational(rational(restricted), state.exact.removedUnvested);
  return { from: subtractRational(to, issueUnits), to };
}

export interface Election83b {
  state: "filed" | "open" | "missed";
  deadline: string;
  filedOn: string | null;
  daysLeft: number | null;
}

/** Whether a certificate starts the 83(b) clock: shares that vest after issue. */
export function needs83b(security: SecurityRecord): boolean {
  return security.kind === "share" && hasVestingSchedule(vestingTermsOf(security));
}

export const election83bDeadline = (security: SecurityRecord): string =>
  addCalendarDays(security.issueDate, ELECTION_83B_DAYS);

/** The certificate's live 83(b) election on `asOf`, if one is recorded. */
export function liveElection(
  book: Pick<EquityBook, "events">,
  security: SecurityRecord,
  asOf: string,
): { id: string; effectiveOn: string } | null {
  const reversed = reversedEvents(book, asOf);
  const election = book.events.find(
    (event) =>
      event.securityId === security.id &&
      event.kind === "election_83b" &&
      event.effectiveOn <= asOf &&
      !reversed.has(event.id),
  );
  return election ? { id: election.id, effectiveOn: election.effectiveOn } : null;
}

/** Where a certificate stands with its 83(b) election on `asOf` (null when none is called for). */
export function election83bStatus(
  book: Pick<EquityBook, "events">,
  security: SecurityRecord,
  asOf: string,
): Election83b | null {
  if (!needs83b(security)) return null;
  const deadline = election83bDeadline(security);
  const filed = liveElection(book, security, "9999-12-31");
  if (filed) return { state: "filed", deadline, filedOn: filed.effectiveOn, daysLeft: null };
  if (asOf <= deadline)
    return {
      state: "open",
      deadline,
      filedOn: null,
      daysLeft: calendarDaysBetween(
        asOf < security.issueDate ? security.issueDate : asOf,
        deadline,
      ),
    };
  return { state: "missed", deadline, filedOn: null, daysLeft: null };
}
