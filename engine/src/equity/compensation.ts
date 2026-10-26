/**
 * Share-based payment cost of an option or RSU award (ASC 718 / IFRS 2):
 * the grant-date fair value per unit times the units expected to vest,
 * attributed over the requisite service period that starts on the grant
 * (issue) date.
 *
 * - Straight-line attribution spreads the award's cost evenly to its final
 *   vesting date, but the cumulative cost recognized at any date is never
 *   less than the grant-date value of the units vested by then.
 * - Graded attribution treats each vesting installment as a separate award
 *   with its own service period from the grant date to its vesting date.
 *
 * Forfeitures are recognized as they occur: units forfeited before vesting
 * leave the award, so the cost previously recognized for them reverses in
 * the period of the forfeiture. Cancelling unvested units without a
 * replacement recognizes their remaining cost on the cancellation date.
 * Expiry of vested options and their exercise change nothing. Early
 * exercise is not a substantive exercise: the units keep their service
 * condition through the company's repurchase right, so their cost is still
 * attributed over the option's schedule, and unvested restricted shares the
 * company repurchases are forfeitures of the matching installments. A void
 * (the record was entered in error) removes the award and reverses all of
 * its cost from the void date. A governed reversal of a forfeiture or
 * cancellation restores its units from the reversal date.
 *
 * Amounts are exact here; the run rounds each award's cumulative cost to the
 * currency's minor unit and posts the change since the previous run.
 */
import { calendarDaysBetween } from "../platform/civil-date.ts";
import { eventsOf, vestingTermsOf } from "./cap-table.ts";
import { equityError, fig } from "./errors.ts";
import {
  addRational,
  compareRational,
  divideRational,
  maxRational,
  minRational,
  multiplyRational,
  ONE,
  parsePrice,
  rational,
  subtractRational,
  sumRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import { splitFactor } from "./splits.ts";
import type { EquityBook, SecurityRecord } from "./types.ts";
import { vestingInstallments } from "./vesting.ts";

interface Tranche {
  date: string;
  units: Rational;
}

/** Whether a security carries share-based payment cost. */
export function isCompensatory(security: SecurityRecord): boolean {
  return (
    (security.kind === "option" || security.kind === "rsu") &&
    security.fairValuePerUnit !== null &&
    security.expenseAttribution !== null
  );
}

/** Remove `units` from the end of the schedule; returns what was removed from tranches after `after`, by tranche date. */
function removeFromTail(
  tranches: Tranche[],
  units: Rational,
  after: string | null,
): { total: Rational; byDate: Tranche[] } {
  let remaining = units;
  let removed = ZERO;
  const byDate: Tranche[] = [];
  for (
    let index = tranches.length - 1;
    index >= 0 && compareRational(remaining, ZERO) > 0;
    index -= 1
  ) {
    const tranche = tranches[index]!;
    if (after !== null && tranche.date <= after) break;
    const take = minRational(tranche.units, remaining);
    if (compareRational(take, ZERO) <= 0) continue;
    tranche.units = subtractRational(tranche.units, take);
    remaining = subtractRational(remaining, take);
    removed = addRational(removed, take);
    byDate.push({ date: tranche.date, units: take });
  }
  return { total: removed, byDate };
}

/**
 * Unvested restricted shares repurchased from the early-exercise
 * certificates of an option through `through`, by the installment date they
 * would have vested on, in the option's issue units.
 */
function repurchasedRestrictedUnits(
  book: Pick<EquityBook, "events" | "splits" | "securities">,
  option: SecurityRecord,
  through: string,
): Tranche[] {
  const out: Tranche[] = [];
  const exercised = new Set(
    eventsOf(book, option.id, through)
      .filter((event) => event.kind === "exercise" && event.resultingSecurityId)
      .map((event) => event.resultingSecurityId!),
  );
  for (const certificate of book.securities) {
    if (
      !exercised.has(certificate.id) ||
      certificate.kind !== "share" ||
      !certificate.vestingTranches ||
      !certificate.shareClassId
    )
      continue;
    const tranches: Tranche[] = certificate.vestingTranches.map((tranche) => ({
      date: tranche.date,
      units: rational(tranche.quantity),
    }));
    const toOption = splitFactor(
      book.splits,
      certificate.shareClassId,
      option.issueDate,
      certificate.issueDate,
    );
    for (const event of eventsOf(book, certificate.id, through)) {
      if (event.kind !== "repurchase" || event.quantity === null) continue;
      const units = divideRational(
        rational(event.quantity),
        splitFactor(
          book.splits,
          certificate.shareClassId,
          certificate.issueDate,
          event.effectiveOn,
        ),
      );
      for (const removed of removeFromTail(tranches, units, event.effectiveOn).byDate) {
        out.push({ date: removed.date, units: divideRational(removed.units, toOption) });
      }
    }
  }
  return out;
}

/** The award's live vesting tranches on `through`, in issue units, after forfeitures and cancellations. */
export function compensationTranches(
  book: Pick<EquityBook, "events" | "splits" | "securities">,
  security: SecurityRecord,
  through: string,
): Tranche[] {
  const terms = vestingTermsOf(security);
  const tranches: Tranche[] = vestingInstallments(terms).map((installment) => ({
    date: installment.date,
    units: rational(installment.quantity),
  }));
  const accelerated: Tranche[] = [];
  for (const event of eventsOf(book, security.id, through)) {
    if (event.kind === "void") return [];
    if (event.kind !== "forfeit" && event.kind !== "cancel") continue;
    if (event.quantity === null || !security.shareClassId) continue;
    const units = divideRational(
      rational(event.quantity),
      splitFactor(book.splits, security.shareClassId, security.issueDate, event.effectiveOn),
    );
    if (event.kind === "forfeit") {
      removeFromTail(tranches, units, null);
    } else {
      // Unvested units cancelled without replacement: their remaining cost lands on the cancellation date.
      const fromUnvested = removeFromTail(tranches, units, event.effectiveOn).total;
      if (compareRational(fromUnvested, ZERO) > 0)
        accelerated.push({ date: event.effectiveOn, units: fromUnvested });
    }
  }
  if (security.kind === "option" && security.earlyExercise) {
    for (const removed of repurchasedRestrictedUnits(book, security, through)) {
      let remaining = removed.units;
      for (const tranche of tranches) {
        if (tranche.date !== removed.date || compareRational(remaining, ZERO) <= 0) continue;
        const take = minRational(tranche.units, remaining);
        tranche.units = subtractRational(tranche.units, take);
        remaining = subtractRational(remaining, take);
      }
    }
  }
  return [...tranches, ...accelerated]
    .filter((tranche) => compareRational(tranche.units, ZERO) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Fraction of a service period [start, end] rendered by `through`. */
function servedFraction(start: string, end: string, through: string): Rational {
  if (through >= end || end <= start) return ONE;
  if (through <= start) return ZERO;
  return rational(
    BigInt(calendarDaysBetween(start, through)),
    BigInt(calendarDaysBetween(start, end)),
  );
}

/** Cumulative cost of an award recognized through `through` (exact money). */
export function cumulativeCompensation(
  book: Pick<EquityBook, "events" | "splits" | "securities">,
  security: SecurityRecord,
  through: string,
): Rational {
  if (!isCompensatory(security)) return ZERO;
  if (through < security.issueDate) return ZERO;
  const fairValue = parsePrice(security.fairValuePerUnit, "fairValuePerUnit");
  if (compareRational(fairValue, ZERO) < 0) {
    throw equityError("awardFairValueNegative", { security: fig.text(security.securityNumber) });
  }
  const tranches = compensationTranches(book, security, through);
  if (tranches.length === 0) return ZERO;
  const start = security.issueDate;
  const costOf = (tranche: Tranche): Rational => multiplyRational(tranche.units, fairValue);
  if (security.expenseAttribution === "graded") {
    return sumRational(
      tranches.map((tranche) =>
        multiplyRational(costOf(tranche), servedFraction(start, tranche.date, through)),
      ),
    );
  }
  const total = sumRational(tranches.map(costOf));
  const end = tranches[tranches.length - 1]!.date;
  const evenly = multiplyRational(total, servedFraction(start, end, through));
  const vested = sumRational(tranches.filter((tranche) => tranche.date <= through).map(costOf));
  return maxRational(evenly, vested);
}

/** Total grant-date cost of the award's live units (what it will have cost once fully vested). */
export function totalCompensation(
  book: Pick<EquityBook, "events" | "splits" | "securities">,
  security: SecurityRecord,
  through: string,
): Rational {
  if (!isCompensatory(security)) return ZERO;
  const fairValue = parsePrice(security.fairValuePerUnit, "fairValuePerUnit");
  return sumRational(
    compensationTranches(book, security, through).map((tranche) =>
      multiplyRational(tranche.units, fairValue),
    ),
  );
}
