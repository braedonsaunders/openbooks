import { PNL_TYPES } from "../records/account-types.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { fromUnits, neg, roundDiv, toUnits } from "../money/money.ts";

/**
 * Pure arithmetic behind an account merge: which balances move, at what
 * exchange rate, and the balanced reclass lines that move them. No database
 * access, so every rule here is unit-tested directly.
 */

/** Account types whose balance is a period flow (closed to retained earnings each fiscal year). */
export const PROFIT_AND_LOSS_TYPES: ReadonlySet<string> = new Set(PNL_TYPES);

/** The dimension tuple a merged balance keeps on the surviving account. */
export interface BalanceDimensions {
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  partyId: string | null;
  equipmentUnitId: string | null;
  paymentCardId: string | null;
  extraDims: Record<string, string>;
}

/** One balance of the source account to transfer, in one book, entity, currency and dimension tuple. */
export interface BalanceGroup extends BalanceDimensions {
  bookId: string;
  subsidiaryId: string;
  /** The subsidiary's functional currency. */
  functionalCurrency: string;
  /** Transaction currency of the lines grouped here. */
  currency: string;
  /** Signed functional amount (debit positive). */
  amount: string;
  /** Signed transaction-currency amount. */
  txnAmount: string;
}

export type TransferRate =
  { ok: true; fxRate: string } | { ok: false; reason: "zero_functional" | "inconsistent_rate" };

const RATE_SCALE = 10_000_000_000n;
/** jl_fx_consistent tolerates 0.005 between amount and round(txn × rate, 4): 50 units at four places. */
const FX_TOLERANCE_UNITS = 50n;

function formatRate(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / RATE_SCALE;
  const fraction = (magnitude % RATE_SCALE).toString().padStart(10, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * The exchange rate a transfer leg carries so its functional and
 * transaction amounts reproduce the grouped balance exactly. A functional
 * currency balance moves at rate 1. A foreign balance moves at its own
 * average historical rate (functional ÷ transaction), which must be
 * positive and reproduce the functional amount within the ledger's
 * rounding tolerance; otherwise the residue needs revaluation or an
 * adjusting entry first.
 */
export function transferRate(
  group: Pick<BalanceGroup, "amount" | "txnAmount" | "currency" | "functionalCurrency">,
): TransferRate {
  const amountUnits = toUnits(group.amount);
  if (amountUnits === 0n) return { ok: false, reason: "zero_functional" };
  if (group.currency === group.functionalCurrency) {
    return toUnits(group.txnAmount) === amountUnits
      ? { ok: true, fxRate: "1.0000000000" }
      : { ok: false, reason: "inconsistent_rate" };
  }
  const txnUnits = toUnits(group.txnAmount);
  // A positive rate needs both amounts on the same side of zero.
  if (txnUnits === 0n || txnUnits > 0n !== amountUnits > 0n)
    return { ok: false, reason: "inconsistent_rate" };
  const magnitude = (units: bigint) => (units < 0n ? -units : units);
  const rateUnits = roundDiv(magnitude(amountUnits) * RATE_SCALE, magnitude(txnUnits));
  if (rateUnits <= 0n) return { ok: false, reason: "inconsistent_rate" };
  const reproduced = roundDiv(txnUnits * rateUnits, RATE_SCALE);
  const drift = reproduced - amountUnits;
  if (drift > FX_TOLERANCE_UNITS || drift < -FX_TOLERANCE_UNITS)
    return { ok: false, reason: "inconsistent_rate" };
  return { ok: true, fxRate: formatRate(rateUnits) };
}

export interface ReclassLine extends BalanceDimensions {
  accountId: string;
  subsidiaryId: string;
  amount: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
}

export interface ReclassEntry {
  bookId: string;
  subsidiaryId: string;
  lines: ReclassLine[];
}

/** A stable key for a group's dimension tuple; equal tuples share a key. */
export function dimensionKey(group: BalanceDimensions & { currency: string }): string {
  return canonicalJson({
    currency: group.currency,
    departmentId: group.departmentId,
    projectId: group.projectId,
    locationId: group.locationId,
    classId: group.classId,
    partyId: group.partyId,
    equipmentUnitId: group.equipmentUnitId,
    paymentCardId: group.paymentCardId,
    extraDims: group.extraDims,
  });
}

/**
 * The reclass entries for a merge: one entry per book and subsidiary, each
 * crediting the source and debiting the survivor by the same amounts on the
 * same dimensions, currency and rate. Every entry therefore balances in
 * total, per subsidiary and per dimension, and leaves the source with a
 * zero balance on every grouped tuple. Groups that cannot move are refused
 * by the caller before this runs; rates are required for every group.
 */
export function buildReclassEntries(
  groups: readonly (BalanceGroup & { fxRate: string })[],
  sourceAccountId: string,
  targetAccountId: string,
): ReclassEntry[] {
  const entries = new Map<string, ReclassEntry>();
  const ordered = [...groups].sort(
    (a, b) =>
      a.bookId.localeCompare(b.bookId) ||
      a.subsidiaryId.localeCompare(b.subsidiaryId) ||
      dimensionKey(a).localeCompare(dimensionKey(b)),
  );
  for (const group of ordered) {
    const key = `${group.bookId}|${group.subsidiaryId}`;
    const entry = entries.get(key) ?? {
      bookId: group.bookId,
      subsidiaryId: group.subsidiaryId,
      lines: [],
    };
    const dims: BalanceDimensions = {
      departmentId: group.departmentId,
      projectId: group.projectId,
      locationId: group.locationId,
      classId: group.classId,
      partyId: group.partyId,
      equipmentUnitId: group.equipmentUnitId,
      paymentCardId: group.paymentCardId,
      extraDims: group.extraDims,
    };
    entry.lines.push(
      {
        ...dims,
        accountId: sourceAccountId,
        subsidiaryId: group.subsidiaryId,
        amount: neg(group.amount),
        currency: group.currency,
        txnAmount: neg(group.txnAmount),
        fxRate: group.fxRate,
      },
      {
        ...dims,
        accountId: targetAccountId,
        subsidiaryId: group.subsidiaryId,
        amount: fromUnits(toUnits(group.amount)),
        currency: group.currency,
        txnAmount: fromUnits(toUnits(group.txnAmount)),
        fxRate: group.fxRate,
      },
    );
    entries.set(key, entry);
  }
  return [...entries.values()];
}

/** Digest of a merge's consequences; the operator confirms exactly what they previewed. */
export function mergeConsequenceDigest(consequences: unknown): string {
  return createHash("sha256").update(canonicalJson(consequences)).digest("hex");
}
