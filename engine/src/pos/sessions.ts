import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { fromUnits } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { businessToday } from "../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  subsidiaryScopeAllows,
  subsidiaryVisibleFilter,
} from "../organization/subsidiary-scope.ts";
import { CashCloseoutError, resolveCashCloseoutAccounts } from "../sales/cash-closeout.ts";
import {
  expectedDrawerCash,
  parsePosAmount,
  totalDenominationCount,
  type DenominationCount,
} from "./cart.ts";
import { posRefusal } from "./errors.ts";
import { postDrawerJournal } from "./journal.ts";
import { acceptedTenderKinds, loadRegisterForUse, type PosRegister } from "./registers.ts";

/**
 * Drawer sessions (shifts). One open session per register, enforced by the
 * partial unique index pos_sessions_one_open_per_register and serialized by
 * the register row lock taken on open. Sales and drawer movements hold the
 * session row FOR SHARE while they post; closing takes it FOR UPDATE, so a
 * close waits for in-flight sales and no sale can land in a closed session
 * (the storage guard refuses it as a backstop). A closed session is final.
 */

export const POS_FEATURE_REMEDY =
  "Turn on Register in Company Settings → Features (it requires Cash sales).";

/** Refuse unless the register feature (and so its Cash sales parent) is on, holding the gate for the transaction. */
export async function assertRegisterFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, "posRegister"))) {
    throw posRefusal(
      "The register is turned off for this organization.",
      "feature_disabled",
      409,
      POS_FEATURE_REMEDY,
    );
  }
}

async function audit(
  runner: SqlExecutor,
  orgId: string,
  table: string,
  rowId: string,
  action: string,
  changes: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})`);
}

export interface PosSessionRow {
  id: string;
  registerId: string;
  subsidiaryId: string;
  sessionNumber: number;
  status: "open" | "closed";
  businessDate: string;
  currency: string;
  openingFloatMinor: bigint;
  openedAt: string;
  openedBy: string;
  closedAt: string | null;
  closedBy: string | null;
  expectedCashMinor: bigint | null;
  countedCashMinor: bigint | null;
  overShortMinor: bigint | null;
  overShortEntryId: string | null;
  closeNote: string | null;
  openingCount: DenominationCount[];
  closingCount: DenominationCount[] | null;
}

type RawSession = Omit<
  PosSessionRow,
  "openingFloatMinor" | "expectedCashMinor" | "countedCashMinor" | "overShortMinor"
> & {
  openingFloatMinor: string;
  expectedCashMinor: string | null;
  countedCashMinor: string | null;
  overShortMinor: string | null;
};

function toSession(row: RawSession): PosSessionRow {
  return {
    ...row,
    openingFloatMinor: BigInt(row.openingFloatMinor),
    expectedCashMinor: row.expectedCashMinor === null ? null : BigInt(row.expectedCashMinor),
    countedCashMinor: row.countedCashMinor === null ? null : BigInt(row.countedCashMinor),
    overShortMinor: row.overShortMinor === null ? null : BigInt(row.overShortMinor),
  };
}

const SESSION_COLUMNS = sql`
  s.id, s.register_id as "registerId", s.subsidiary_id as "subsidiaryId",
  s.session_number as "sessionNumber", s.status, s.business_date::text as "businessDate",
  s.currency, s.opening_float_minor::text as "openingFloatMinor", s.opened_at::text as "openedAt",
  s.opened_by as "openedBy", s.closed_at::text as "closedAt", s.closed_by as "closedBy",
  s.expected_cash_minor::text as "expectedCashMinor", s.counted_cash_minor::text as "countedCashMinor",
  s.over_short_minor::text as "overShortMinor", s.over_short_entry_id as "overShortEntryId",
  s.close_note as "closeNote", s.opening_count as "openingCount", s.closing_count as "closingCount"`;

/**
 * Read and lock a session in the actor's scope. `share` holds it open for a
 * sale or movement; `update` serializes a close.
 */
export async function lockSession(
  runner: SqlExecutor,
  orgId: string,
  sessionId: string,
  mode: "share" | "update" | "none",
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PosSessionRow> {
  if (!isUuid(sessionId)) {
    throw posRefusal(
      "This register session does not exist.",
      "session_not_found",
      404,
      "Reopen the register and continue in its open session.",
    );
  }
  const lock =
    mode === "share" ? sql`for share of s` : mode === "update" ? sql`for update of s` : sql``;
  const row = (
    await runner.execute<RawSession>(
      sql`
    select ${SESSION_COLUMNS} from pos_sessions s
     where s.org_id = ${orgId} and s.id = ${sessionId} ${lock}`,
      "objects",
    )
  )[0];
  if (!row || !subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiaryId)) {
    throw posRefusal(
      "This register session does not exist.",
      "session_not_found",
      404,
      "Reopen the register and continue in its open session.",
    );
  }
  return toSession(row);
}

export function assertSessionOpen(session: PosSessionRow): void {
  if (session.status !== "open") {
    throw posRefusal(
      `Session ${session.sessionNumber} is closed.`,
      "session_not_open",
      409,
      "Open a new session on the register to continue selling.",
    );
  }
}

/** The register's open session, or null. */
export async function openSessionForRegister(
  runner: SqlExecutor,
  orgId: string,
  registerId: string,
): Promise<PosSessionRow | null> {
  const row = (
    await runner.execute<RawSession>(
      sql`
    select ${SESSION_COLUMNS} from pos_sessions s
     where s.org_id = ${orgId} and s.register_id = ${registerId} and s.status = 'open'`,
      "objects",
    )
  )[0];
  return row ? toSession(row) : null;
}

export interface OpenSessionInput {
  orgId: string;
  actorId: string;
  registerId: string;
  openingCount: DenominationCount[];
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

/** Open a drawer session with its counted float. Refuses a second open session on the register. */
export async function openSession(input: OpenSessionInput): Promise<PosSessionRow> {
  return withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const register = await loadRegisterForUse(db, input.orgId, input.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      lock: true,
    });
    const existing = await openSessionForRegister(db, input.orgId, register.id);
    if (existing) {
      throw posRefusal(
        `Register ${register.code} already has session ${existing.sessionNumber} open.`,
        "session_already_open",
        409,
        "Continue in the open session, or close it with its drawer count before opening another.",
        { sessionId: existing.id },
      );
    }
    const count = totalDenominationCount(
      input.openingCount,
      register.denominations,
      register.currencyDecimals,
    );
    const businessDate = await businessToday(input.orgId);
    const next = (
      await db.execute<{ next: number }>(
        sql`
      select coalesce(max(session_number), 0) + 1 as next from pos_sessions
       where org_id = ${input.orgId} and register_id = ${register.id}`,
        "objects",
      )
    )[0]!.next;
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into pos_sessions
        (org_id, register_id, subsidiary_id, session_number, status, business_date, currency,
         opening_float_minor, opening_count, opened_by, created_by, updated_by)
      values (${input.orgId}, ${register.id}, ${register.subsidiaryId}, ${Number(next)}, 'open', ${businessDate},
        ${register.currency}, ${count.totalUnits.toString()}::bigint, ${JSON.stringify(count.rows)}::jsonb,
        ${input.actorId}, ${input.actorId}, ${input.actorId})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new Error("register session insert returned an unexpected row count");
    const sessionId = inserted[0]!.id;
    await audit(
      db,
      input.orgId,
      "pos_sessions",
      sessionId,
      "open",
      {
        registerId: register.id,
        sessionNumber: Number(next),
        openingFloat: fromUnits(count.totalUnits),
        openingCount: count.rows,
      },
      input.actorId,
    );
    return lockSession(db, input.orgId, sessionId, "none", input.allowedSubsidiaryIds);
  });
}

export interface SessionTenderTotal {
  kind: string;
  methodLabel: string;
  saleMinor: bigint;
  refundMinor: bigint;
}

export interface SessionSummary {
  session: PosSessionRow;
  register: { id: string; code: string; name: string };
  saleCount: number;
  refundCount: number;
  /** Sales and refunds that settled exactly zero (discounted or comped in full); they carry no tenders. */
  noChargeSaleCount: number;
  noChargeRefundCount: number;
  salesTotalMinor: bigint;
  refundsTotalMinor: bigint;
  tenders: SessionTenderTotal[];
  payInMinor: bigint;
  payOutMinor: bigint;
  saleCashMinor: bigint;
  refundCashMinor: bigint;
  expectedCashMinor: bigint;
  movements: Array<{
    id: string;
    kind: string;
    reason: string;
    amountMinor: bigint;
    note: string | null;
    createdAt: string;
    journalEntryId: string;
  }>;
}

/**
 * The X report (any time) and the basis of the Z report: what the session
 * sold and refunded, by tender, and the cash the drawer should hold. Cash
 * comes from the posted documents' own tender rows, the single source the
 * ledger posted from, never from a second tally.
 */
export async function readSessionSummary(
  runner: SqlExecutor,
  orgId: string,
  sessionId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  lockedSession?: PosSessionRow,
): Promise<SessionSummary> {
  const session =
    lockedSession ?? (await lockSession(runner, orgId, sessionId, "none", allowedSubsidiaryIds));
  const register = (
    await runner.execute<{ id: string; code: string; name: string; cash_account_id: string }>(
      sql`
    select id, code, name, cash_account_id from pos_registers where org_id = ${orgId} and id = ${session.registerId}`,
      "objects",
    )
  )[0]!;
  const totals = (
    await runner.execute<{
      sale_count: number;
      refund_count: number;
      no_charge_sale_count: number;
      no_charge_refund_count: number;
      sales_total: string;
      refunds_total: string;
    }>(
      sql`
    select count(*) filter (where t.kind = 'sale')::int as sale_count,
           count(*) filter (where t.kind = 'refund')::int as refund_count,
           count(*) filter (where t.kind = 'sale' and t.total_minor = 0)::int as no_charge_sale_count,
           count(*) filter (where t.kind = 'refund' and t.total_minor = 0)::int as no_charge_refund_count,
           coalesce(sum(t.total_minor) filter (where t.kind = 'sale'), 0)::text as sales_total,
           coalesce(sum(t.total_minor) filter (where t.kind = 'refund'), 0)::text as refunds_total
      from pos_transactions t
      join documents d on d.org_id = t.org_id and d.id = t.document_id and d.status = 'posted' -- Live entries only: voided transactions do not contribute to current session reconciliation
     where t.org_id = ${orgId} and t.session_id = ${session.id}`,
      "objects",
    )
  )[0]!;
  const tenders = await runner.execute<{
    kind: string;
    method_label: string;
    sale_minor: string;
    refund_minor: string;
    cash_minor: string;
    refund_cash_minor: string;
  }>(
    sql`
    select dt.kind, dt.method_label,
           coalesce(sum(dt.amount_minor) filter (where t.kind = 'sale'), 0)::text as sale_minor,
           coalesce(sum(dt.amount_minor) filter (where t.kind = 'refund'), 0)::text as refund_minor,
           coalesce(sum(dt.amount_minor) filter (where t.kind = 'sale' and dt.kind = 'cash' and dt.account_id = ${register.cash_account_id}::uuid), 0)::text as cash_minor,
           coalesce(sum(dt.amount_minor) filter (where t.kind = 'refund' and dt.kind = 'cash' and dt.account_id = ${register.cash_account_id}::uuid), 0)::text as refund_cash_minor
      from pos_transactions t
      join documents d on d.org_id = t.org_id and d.id = t.document_id and d.status = 'posted'
      join document_tenders dt on dt.org_id = t.org_id and dt.document_id = t.document_id
     where t.org_id = ${orgId} and t.session_id = ${session.id}
     group by dt.kind, dt.method_label
     order by dt.kind, dt.method_label`,
    "objects",
  );
  const movements = await runner.execute<{
    id: string;
    kind: string;
    reason: string;
    amount_minor: string;
    note: string | null;
    created_at: string;
    journal_entry_id: string;
  }>(
    sql`
    select m.id, m.kind, r.name as reason, m.amount_minor::text as amount_minor, m.note,
           m.created_at::text as created_at, m.journal_entry_id
      from pos_cash_movements m
      join pos_cash_reasons r on r.org_id = m.org_id and r.id = m.reason_id
     where m.org_id = ${orgId} and m.session_id = ${session.id}
     order by m.created_at`,
    "objects",
  );
  const saleCashMinor = tenders.reduce((total, row) => total + BigInt(row.cash_minor), 0n);
  const refundCashMinor = tenders.reduce((total, row) => total + BigInt(row.refund_cash_minor), 0n);
  const payInMinor = movements
    .filter((m) => m.kind === "pay_in")
    .reduce((total, m) => total + BigInt(m.amount_minor), 0n);
  const payOutMinor = movements
    .filter((m) => m.kind === "pay_out")
    .reduce((total, m) => total + BigInt(m.amount_minor), 0n);
  return {
    session,
    register: { id: register.id, code: register.code, name: register.name },
    saleCount: Number(totals.sale_count),
    refundCount: Number(totals.refund_count),
    noChargeSaleCount: Number(totals.no_charge_sale_count),
    noChargeRefundCount: Number(totals.no_charge_refund_count),
    salesTotalMinor: BigInt(totals.sales_total),
    refundsTotalMinor: BigInt(totals.refunds_total),
    tenders: tenders.map((row) => ({
      kind: row.kind,
      methodLabel: row.method_label,
      saleMinor: BigInt(row.sale_minor),
      refundMinor: BigInt(row.refund_minor),
    })),
    payInMinor,
    payOutMinor,
    saleCashMinor,
    refundCashMinor,
    expectedCashMinor: expectedDrawerCash({
      openingFloatUnits: session.openingFloatMinor,
      saleCashUnits: saleCashMinor,
      refundCashUnits: refundCashMinor,
      payInUnits: payInMinor,
      payOutUnits: payOutMinor,
    }),
    movements: movements.map((m) => ({
      id: m.id,
      kind: m.kind,
      reason: m.reason,
      amountMinor: BigInt(m.amount_minor),
      note: m.note,
      createdAt: m.created_at,
      journalEntryId: m.journal_entry_id,
    })),
  };
}

export interface CashMovementInput {
  orgId: string;
  actorId: string;
  sessionId: string;
  reasonId: string;
  amount: string;
  note: string | null;
  idempotencyKey: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

/**
 * Pay cash into or out of an open drawer against a configured reason. The
 * journal moves the register's cash account against the reason's account
 * and the movement row records it; both commit together, and a retried key
 * returns the movement it already recorded.
 */
export async function recordCashMovement(
  input: CashMovementInput,
): Promise<{ id: string; journalEntryId: string; replayed: boolean }> {
  if (!isUuid(input.idempotencyKey)) {
    throw posRefusal(
      "The movement carries no valid request key.",
      "invalid_input",
      422,
      "Retry the movement from the register.",
    );
  }
  const note = input.note?.trim() || null;
  if (note && note.length > 500) {
    throw posRefusal(
      "The movement note is longer than 500 characters.",
      "invalid_input",
      422,
      "Shorten the note to 500 characters.",
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const prior = (
      await db.execute<{
        id: string;
        journal_entry_id: string;
        session_id: string;
        reason_id: string;
        amount_minor: string;
      }>(
        sql`
      select id, journal_entry_id, session_id, reason_id, amount_minor::text as amount_minor from pos_cash_movements
       where org_id = ${input.orgId} and idempotency_key = ${input.idempotencyKey}`,
        "objects",
      )
    )[0];
    const session = await lockSession(
      db,
      input.orgId,
      input.sessionId,
      "share",
      input.allowedSubsidiaryIds,
    );
    const register = await loadRegisterForUse(db, input.orgId, session.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    const amountUnits = parsePosAmount(
      input.amount,
      "The movement amount",
      register.currencyDecimals,
    );
    if (prior) {
      if (
        prior.session_id !== session.id ||
        prior.reason_id !== input.reasonId ||
        BigInt(prior.amount_minor) !== amountUnits
      ) {
        throw posRefusal(
          "This request key was already used for a different movement.",
          "idempotency_conflict",
          409,
          "Reload the register and record the movement again.",
        );
      }
      return { id: prior.id, journalEntryId: prior.journal_entry_id, replayed: true };
    }
    assertSessionOpen(session);
    if (amountUnits <= 0n) {
      throw posRefusal(
        "The movement amount must be greater than zero.",
        "invalid_input",
        422,
        "Enter the cash amount paid in or out.",
      );
    }
    if (!isUuid(input.reasonId)) {
      throw posRefusal(
        "Choose a pay-in or pay-out reason.",
        "reason_not_found",
        404,
        "Pick a reason configured in Setup → Sales → Register cash reasons.",
      );
    }
    const reason = (
      await db.execute<{
        id: string;
        name: string;
        direction: "pay_in" | "pay_out";
        account_id: string;
      }>(
        sql`
      select id, name, direction, account_id from pos_cash_reasons
       where org_id = ${input.orgId} and id = ${input.reasonId} and is_active
       for share`,
        "objects",
      )
    )[0];
    if (!reason) {
      throw posRefusal(
        "That cash reason does not exist or is inactive.",
        "reason_not_found",
        404,
        "Pick a reason configured in Setup → Sales → Register cash reasons.",
      );
    }
    const signed = reason.direction === "pay_in" ? amountUnits : -amountUnits;
    const postingDate = await businessToday(input.orgId);
    const journalEntryId = await postDrawerJournal(db, {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: register.subsidiaryId,
      postingDate,
      entryNumberBase: `POS-${register.code}-${session.sessionNumber}-${reason.direction === "pay_in" ? "IN" : "OUT"}`,
      memo: `${register.code} session ${session.sessionNumber} · ${reason.name}${note ? ` · ${note}` : ""}`,
      cashUnits: signed,
      cashAccountId: register.cashAccountId,
      counterAccountId: reason.account_id,
      locationId: register.locationId,
      idempotencyKey: `pos:movement:${input.idempotencyKey}`,
      auditChanges: {
        registerId: register.id,
        sessionId: session.id,
        reasonId: reason.id,
        kind: reason.direction,
      },
    });
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into pos_cash_movements
        (org_id, session_id, kind, reason_id, amount_minor, note, journal_entry_id, idempotency_key, created_by)
      values (${input.orgId}, ${session.id}, ${reason.direction}, ${reason.id}, ${amountUnits.toString()}::bigint,
        ${note}, ${journalEntryId}, ${input.idempotencyKey}, ${input.actorId})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new Error("drawer movement insert returned an unexpected row count");
    return { id: inserted[0]!.id, journalEntryId, replayed: false };
  });
}

export interface CloseSessionInput {
  orgId: string;
  actorId: string;
  sessionId: string;
  closingCount: DenominationCount[];
  note: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

/**
 * Close a session with its blind count (the Z report). The expected cash is
 * computed under the session's exclusive lock, so no sale can land between
 * the expectation and the close. A nonzero over/short posts between the
 * register's cash account and the organization's configured cash over/short
 * control account, the same account a sale's own close-out posts to.
 */
export async function closeSession(input: CloseSessionInput): Promise<SessionSummary> {
  const note = input.note?.trim() || null;
  if (note && note.length > 1000) {
    throw posRefusal(
      "The closing note is longer than 1000 characters.",
      "invalid_input",
      422,
      "Shorten the note to 1000 characters.",
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const session = await lockSession(
      db,
      input.orgId,
      input.sessionId,
      "update",
      input.allowedSubsidiaryIds,
    );
    assertSessionOpen(session);
    const register = await loadRegisterForUse(db, input.orgId, session.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    const count = totalDenominationCount(
      input.closingCount,
      register.denominations,
      register.currencyDecimals,
    );
    const summary = await readSessionSummary(
      db,
      input.orgId,
      session.id,
      input.allowedSubsidiaryIds,
      session,
    );
    const overShort = count.totalUnits - summary.expectedCashMinor;
    let entryId: string | null = null;
    if (overShort !== 0n) {
      let overShortAccountId: string | null;
      try {
        overShortAccountId = (
          await resolveCashCloseoutAccounts(db, input.orgId, {
            tipsTotalMinor: 0n,
            feeTotalMinor: 0n,
            overShortMinor: overShort,
            serverPartyId: null,
            parts: [],
          })
        ).cashOverShortAccountId;
      } catch (error) {
        if (error instanceof CashCloseoutError) {
          throw posRefusal(
            `The drawer count is ${overShort > 0n ? "over" : "short"} by ${fromUnits(overShort < 0n ? -overShort : overShort)}, but no usable cash over/short account is configured to record the difference.`,
            "register_misconfigured",
            422,
            "Choose an active cash over/short account in Setup → Company & Accounting → Control accounts, then close the session again.",
          );
        }
        throw error;
      }
      if (!overShortAccountId)
        throw new Error("cash over/short account did not resolve for a nonzero difference");
      entryId = await postDrawerJournal(db, {
        orgId: input.orgId,
        actorId: input.actorId,
        subsidiaryId: register.subsidiaryId,
        postingDate: await businessToday(input.orgId),
        entryNumberBase: `POS-${register.code}-${session.sessionNumber}-CLOSE`,
        memo: `${register.code} session ${session.sessionNumber} · cash ${overShort > 0n ? "over" : "short"}`,
        cashUnits: overShort,
        cashAccountId: register.cashAccountId,
        counterAccountId: overShortAccountId,
        locationId: register.locationId,
        idempotencyKey: `pos:session-close:${session.id}`,
        auditChanges: {
          registerId: register.id,
          sessionId: session.id,
          expected: fromUnits(summary.expectedCashMinor),
          counted: fromUnits(count.totalUnits),
        },
      });
    }
    const updated = await db.execute<{ id: string }>(
      sql`
      update pos_sessions
         set status = 'closed', closed_at = now(), closed_by = ${input.actorId},
             expected_cash_minor = ${summary.expectedCashMinor.toString()}::bigint,
             counted_cash_minor = ${count.totalUnits.toString()}::bigint,
             over_short_minor = ${overShort.toString()}::bigint,
             closing_count = ${JSON.stringify(count.rows)}::jsonb,
             over_short_entry_id = ${entryId},
             close_note = ${note},
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${session.id} and status = 'open'
       returning id`,
      "objects",
    );
    if (updated.length !== 1) {
      throw posRefusal(
        "The session changed while it was being closed.",
        "session_not_open",
        409,
        "Reload the register and review the session before closing it again.",
      );
    }
    await audit(
      db,
      input.orgId,
      "pos_sessions",
      session.id,
      "close",
      {
        before: { status: "open" },
        after: {
          status: "closed",
          expected: fromUnits(summary.expectedCashMinor),
          counted: fromUnits(count.totalUnits),
          overShort: fromUnits(overShort),
          overShortEntryId: entryId,
        },
        reason: note,
      },
      input.actorId,
    );
    const closed = await lockSession(
      db,
      input.orgId,
      session.id,
      "none",
      input.allowedSubsidiaryIds,
    );
    return { ...summary, session: closed };
  });
}

export type SessionListRow = {
  id: string;
  registerId: string;
  registerCode: string;
  registerName: string;
  sessionNumber: number;
  status: string;
  businessDate: string;
  currency: string;
  openedAt: string;
  openedByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  openingFloatMinor: string;
  expectedCashMinor: string | null;
  countedCashMinor: string | null;
  overShortMinor: string | null;
  saleCount: number;
  salesTotalMinor: string;
  refundsTotalMinor: string;
};

/**
 * Session history for the Z report list, newest first. The legal-entity
 * scope is part of the query, so the total and every page window count only
 * sessions the caller may see.
 */
export async function listSessions(
  runner: SqlExecutor,
  orgId: string,
  filters: {
    registerId?: string | null;
    status?: "open" | "closed" | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ rows: SessionListRow[]; total: number; hasMore: boolean }> {
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 50), 1), 200);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const where = sql`
     where s.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`s.subsidiary_id`, allowedSubsidiaryIds)}
       ${filters.registerId && isUuid(filters.registerId) ? sql`and s.register_id = ${filters.registerId}` : sql``}
       ${filters.status ? sql`and s.status = ${filters.status}` : sql``}
       ${filters.from ? sql`and s.business_date >= ${filters.from}::date` : sql``}
       ${filters.to ? sql`and s.business_date <= ${filters.to}::date` : sql``}`;
  const total =
    (
      await runner.execute<{ total: number }>(
        sql`select count(*)::int as total from pos_sessions s ${where}`,
        "objects",
      )
    )[0]?.total ?? 0;
  const rows = await runner.execute<SessionListRow>(
    sql`
    select s.id, s.register_id as "registerId", r.code as "registerCode", r.name as "registerName",
           s.session_number as "sessionNumber", s.status, s.business_date::text as "businessDate", s.currency,
           s.opened_at::text as "openedAt", ou.name as "openedByName", s.closed_at::text as "closedAt",
           cu.name as "closedByName", s.opening_float_minor::text as "openingFloatMinor",
           s.expected_cash_minor::text as "expectedCashMinor", s.counted_cash_minor::text as "countedCashMinor",
           s.over_short_minor::text as "overShortMinor",
           coalesce(t.sale_count, 0)::int as "saleCount",
           coalesce(t.sales_total, 0)::text as "salesTotalMinor",
           coalesce(t.refunds_total, 0)::text as "refundsTotalMinor"
      from pos_sessions s
      join pos_registers r on r.org_id = s.org_id and r.id = s.register_id
      left join users ou on ou.org_id = s.org_id and ou.id = s.opened_by
      left join users cu on cu.org_id = s.org_id and cu.id = s.closed_by
      left join lateral (
        select count(*) filter (where pt.kind = 'sale') as sale_count,
               sum(pt.total_minor) filter (where pt.kind = 'sale') as sales_total,
               sum(pt.total_minor) filter (where pt.kind = 'refund') as refunds_total
          from pos_transactions pt
          join documents d on d.org_id = pt.org_id and d.id = pt.document_id and d.status = 'posted' -- Live entries only: voided transactions do not contribute to current session totals
         where pt.org_id = s.org_id and pt.session_id = s.id
      ) t on true
     ${where}
     order by s.opened_at desc, s.id
     limit ${limit} offset ${offset}`,
    "objects",
  );
  return { rows, total, hasMore: offset + rows.length < total };
}

/** Register context for the register screen: configuration the cashier needs and the open session. */
export async function readRegisterContext(
  runner: SqlExecutor,
  orgId: string,
  registerId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{
  register: PosRegister;
  acceptedTenders: ReturnType<typeof acceptedTenderKinds>;
  session: PosSessionRow | null;
  quickKeys: Array<{ itemId: string; label: string; code: string | null }>;
  cashReasons: Array<{ id: string; name: string; direction: string }>;
  defaultCustomerName: string | null;
}> {
  const register = await loadRegisterForUse(runner, orgId, registerId, { allowedSubsidiaryIds });
  const session = await openSessionForRegister(runner, orgId, register.id);
  const quickKeys = await runner.execute<{ itemId: string; label: string; code: string | null }>(
    sql`
    select k.item_id as "itemId", coalesce(k.label, i.name) as label, i.code
      from pos_quick_keys k
      join items i on i.org_id = k.org_id and i.id = k.item_id and i.is_active
     where k.org_id = ${orgId} and k.is_active and (k.register_id is null or k.register_id = ${register.id})
     order by k.position, coalesce(k.label, i.name)
     limit 60`,
    "objects",
  );
  const cashReasons = await runner.execute<{ id: string; name: string; direction: string }>(
    sql`
    select id, name, direction from pos_cash_reasons where org_id = ${orgId} and is_active order by direction, name`,
    "objects",
  );
  const defaultCustomerName = register.defaultCustomerId
    ? ((
        await runner.execute<{ name: string }>(
          sql`
        select display_name as name from parties where org_id = ${orgId} and id = ${register.defaultCustomerId}`,
          "objects",
        )
      )[0]?.name ?? null)
    : null;
  return {
    register,
    acceptedTenders: acceptedTenderKinds(register),
    session,
    quickKeys,
    cashReasons,
    defaultCustomerName,
  };
}
