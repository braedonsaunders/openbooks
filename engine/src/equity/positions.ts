/**
 * The position-movements ledger: the cap table as append-only movements, so
 * a SQL sum of the rows effective on or before a date is the cap table on
 * that date.
 *
 * One position per share certificate and award (its outstanding shares in
 * its class, and those shares as converted into common) and one per plan
 * pool (its unallocated shares). A position's value on a date is read from
 * the cap-table replay (cap-table.ts), the single source of truth: split
 * restatement, conversion-price adjustments, voids, reversals and plan
 * recycling all come from there. Positions change only on dated records —
 * an issue, an event, a reversal, a void, a split, a class amendment, a plan
 * or reserve change — so a position's movements are the changes of its
 * value across those dates.
 *
 * After every equity write the ledger is reconciled to the replay in the
 * same transaction: for each position and each date on which it can change
 * (or already carries a movement), a movement is appended for any
 * difference between the replayed value and the sum recorded so far. Rows
 * are never edited or deleted; a backdated event or a reversal appends
 * movements dated where its effect begins.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { conversionRatio, holdingState, planPool } from "./cap-table.ts";
import { equityError } from "./errors.ts";
import { floorShares, multiplyRational, rational } from "./quantities.ts";
import { loadEquityBook } from "./store.ts";
import type { EquityBook, PlanRecord, SecurityRecord } from "./types.ts";

export type PositionKind = "share" | "award" | "pool";

export interface PositionValue {
  shares: bigint;
  asConverted: bigint;
}

export interface PositionMovement {
  kind: PositionKind;
  securityId: string | null;
  planId: string | null;
  effectiveOn: string;
  sharesDelta: bigint;
  asConvertedDelta: bigint;
}

interface PositionKey {
  kind: PositionKind;
  securityId: string | null;
  planId: string | null;
}

const keyOf = (key: PositionKey): string =>
  key.planId ? `p:${key.planId}` : `s:${key.securityId}`;

/** A share certificate's or award's position on a date: outstanding shares and their common equivalent. */
export function securityPosition(
  book: EquityBook,
  security: SecurityRecord,
  on: string,
): PositionValue {
  if (security.quantity === null || !security.shareClassId || on < security.issueDate)
    return { shares: 0n, asConverted: 0n };
  const shares = holdingState(book, security, on).outstanding;
  if (shares === 0n) return { shares: 0n, asConverted: 0n };
  const shareClass = book.classes.find((row) => row.id === security.shareClassId)!;
  return {
    shares,
    asConverted: floorShares(
      multiplyRational(rational(shares), conversionRatio(book, shareClass, on)),
    ),
  };
}

/** A plan pool's position on a date: its unallocated shares (never below zero) and their common equivalent. */
export function poolPosition(book: EquityBook, plan: PlanRecord, on: string): PositionValue {
  if (on < plan.effectiveOn) return { shares: 0n, asConverted: 0n };
  const available = planPool(book, plan, on).available;
  const shares = available > 0n ? available : 0n;
  if (shares === 0n) return { shares: 0n, asConverted: 0n };
  const shareClass = book.classes.find((row) => row.id === plan.shareClassId)!;
  return {
    shares,
    asConverted: floorShares(
      multiplyRational(rational(shares), conversionRatio(book, shareClass, on)),
    ),
  };
}

/**
 * The dates a certificate's or award's position can change: its issue, its
 * own events, reversals of those events, voids of the certificates they
 * produced, and every split and class amendment (which restate shares and
 * conversion ratios).
 */
function securityDates(
  book: EquityBook,
  security: SecurityRecord,
  classDates: readonly string[],
): string[] {
  const dates = new Set<string>([security.issueDate, ...classDates]);
  const own = new Set<string>();
  const produced = new Set<string>();
  for (const event of book.events) {
    if (event.securityId !== security.id) continue;
    own.add(event.id);
    dates.add(event.effectiveOn);
    if (event.resultingSecurityId) produced.add(event.resultingSecurityId);
  }
  for (const event of book.events) {
    if (event.kind === "reverse" && event.reversesEventId && own.has(event.reversesEventId))
      dates.add(event.effectiveOn);
    if (event.kind === "void" && produced.has(event.securityId)) dates.add(event.effectiveOn);
  }
  return [...dates].filter((date) => date >= security.issueDate).sort();
}

/** Every dated record of the book: a plan pool can change only on one of these dates. */
function bookDates(book: EquityBook): string[] {
  const dates = new Set<string>();
  for (const row of book.securities) dates.add(row.issueDate);
  for (const row of book.events) dates.add(row.effectiveOn);
  for (const row of book.splits) dates.add(row.effectiveOn);
  for (const row of book.amendments) dates.add(row.effectiveOn);
  for (const row of book.reserveChanges) dates.add(row.effectiveOn);
  for (const row of book.plans) dates.add(row.effectiveOn);
  for (const row of book.classes) dates.add(row.effectiveOn);
  return [...dates].sort();
}

/**
 * The movements that bring recorded movements in line with the replay. The
 * recorded movements are sums per position and date; the result is what to
 * append, dated on each position's change dates.
 */
export function reconcilePositions(
  book: EquityBook,
  recorded: readonly PositionMovement[],
): PositionMovement[] {
  const dates = bookDates(book);
  const classDates = [
    ...new Set([
      ...book.splits.map((row) => row.effectiveOn),
      ...book.amendments.map((row) => row.effectiveOn),
    ]),
  ];
  const recordedByKey = new Map<string, PositionMovement[]>();
  for (const row of recorded) {
    const key = keyOf(row);
    const list = recordedByKey.get(key) ?? [];
    list.push(row);
    recordedByKey.set(key, list);
  }
  const keys: { key: PositionKey; dates: string[]; value: (on: string) => PositionValue }[] = [
    ...book.securities
      .filter((security) => security.quantity !== null && security.shareClassId)
      .map((security) => ({
        key: {
          kind: (security.kind === "share" ? "share" : "award") as PositionKind,
          securityId: security.id,
          planId: null,
        },
        dates: securityDates(book, security, classDates),
        value: (on: string) => securityPosition(book, security, on),
      })),
    ...book.plans.map((plan) => ({
      key: { kind: "pool" as PositionKind, securityId: null, planId: plan.id },
      dates: dates.filter((date) => date >= plan.effectiveOn),
      value: (on: string) => poolPosition(book, plan, on),
    })),
  ];
  const out: PositionMovement[] = [];
  for (const { key, dates: changeDates, value } of keys) {
    const existing = recordedByKey.get(keyOf(key)) ?? [];
    const checkDates = [
      ...new Set([...changeDates, ...existing.map((row) => row.effectiveOn)]),
    ].sort();
    const recordedAt = new Map<string, { shares: bigint; asConverted: bigint }>();
    for (const row of existing) {
      const at = recordedAt.get(row.effectiveOn) ?? { shares: 0n, asConverted: 0n };
      at.shares += row.sharesDelta;
      at.asConverted += row.asConvertedDelta;
      recordedAt.set(row.effectiveOn, at);
    }
    let shares = 0n;
    let asConverted = 0n;
    for (const date of checkDates) {
      const at = recordedAt.get(date);
      if (at) {
        shares += at.shares;
        asConverted += at.asConverted;
      }
      const target = value(date);
      const sharesDelta = target.shares - shares;
      const asConvertedDelta = target.asConverted - asConverted;
      if (sharesDelta !== 0n || asConvertedDelta !== 0n) {
        out.push({ ...key, effectiveOn: date, sharesDelta, asConvertedDelta });
        shares = target.shares;
        asConverted = target.asConverted;
      }
    }
  }
  return out;
}

/** Recorded movements of a legal entity, summed per position and date. */
async function recordedMovements(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<PositionMovement[]> {
  const rows = await runner.execute<{
    position_kind: PositionKind;
    security_id: string | null;
    plan_id: string | null;
    effective_on: string;
    shares: string;
    as_converted: string;
  }>(
    sql`
    select position_kind, security_id, plan_id, effective_on::text as effective_on,
           sum(shares_delta)::text as shares, sum(as_converted_delta)::text as as_converted
      from equity_position_movements
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
     group by position_kind, security_id, plan_id, effective_on`,
    "objects",
  );
  return rows.map((row) => ({
    kind: row.position_kind,
    securityId: row.security_id,
    planId: row.plan_id,
    effectiveOn: row.effective_on,
    sharesDelta: BigInt(row.shares),
    asConvertedDelta: BigInt(row.as_converted),
  }));
}

/**
 * Reconcile the legal entity's position ledger to its replayed history,
 * inside the caller's transaction (which holds the entity's equity lock).
 * Returns the number of movements appended.
 */
export async function syncPositionLedger(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<number> {
  const book = await loadEquityBook(runner, orgId, subsidiaryId);
  const append = reconcilePositions(book, await recordedMovements(runner, orgId, subsidiaryId));
  if (append.length === 0) return 0;
  for (let start = 0; start < append.length; start += 500) {
    const batch = append.slice(start, start + 500);
    const values = batch.map(
      (
        row,
      ) => sql`(${orgId}, ${subsidiaryId}, ${row.kind}, ${row.securityId}, ${row.planId}, ${row.effectiveOn}::date,
      ${row.sharesDelta.toString()}::bigint, ${row.asConvertedDelta.toString()}::bigint)`,
    );
    const written = await runner.execute<{ id: string }>(
      sql`
      insert into equity_position_movements (org_id, subsidiary_id, position_kind, security_id, plan_id, effective_on, shares_delta, as_converted_delta)
      values ${sql.join(values, sql`, `)}
      returning id`,
      "objects",
    );
    if (written.length !== batch.length) {
      throw equityError("positionsStale");
    }
  }
  return append.length;
}

/** The cap table a SQL sum of the ledger gives on a date, per position (for verification). */
export async function ledgerPositions(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  on: string,
): Promise<Map<string, PositionValue>> {
  const rows = await runner.execute<{
    security_id: string | null;
    plan_id: string | null;
    shares: string;
    as_converted: string;
  }>(
    sql`
    select security_id, plan_id, sum(shares_delta)::text as shares, sum(as_converted_delta)::text as as_converted
      from equity_position_movements
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and effective_on <= ${on}::date
     group by security_id, plan_id`,
    "objects",
  );
  return new Map(
    rows.map((row) => [
      row.plan_id ? `p:${row.plan_id}` : `s:${row.security_id}`,
      { shares: BigInt(row.shares), asConverted: BigInt(row.as_converted) },
    ]),
  );
}
