import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { neg, normalizeDecimal, toUnits, wholeDigits } from "../money/money.ts";
import { parseMoney } from "../money/brands.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
  SubsidiaryError,
  uuidArray,
  validateSubsidiaryRestrictions,
  type SubLine,
} from "../organization/subsidiaries.ts";
import { loadIntercompanyPair } from "../organization/intercompany-accounts.ts";
import { postEntry, type PostEntryResult } from "../journal/post-entry.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import {
  auditIntercompany,
  IntercompanyError,
  INTERCOMPANY_NETTING_DISABLED,
  requireOneRow,
  requireIntercompanyPermission,
} from "./errors.ts";
import {
  assertIntercompanyPeriodsOpen,
  intercompanyPostingBook,
  intercompanyPostingPeriod,
  intercompanyPostingRefusal,
  postMirrorReversal,
  resolveSpotRates,
} from "./ledger-support.ts";
import { spotTranslation } from "./netting-math.ts";

/**
 * Bank transfers between two entities' bank accounts.
 *
 * A transfer inside one entity is an ordinary bank transfer document, which
 * keeps both legs in that entity. Moving cash between legal entities is an
 * intercompany event: the paying entity credits its bank and the receiving
 * entity debits its bank, and the posting adds the due-to/due-from legs of
 * their intercompany pair so each entity balances on its own and the
 * position is settled later by netting. Both accounts must hold the same
 * currency; each entity translates at its own spot rate on the transfer date.
 */

export interface FundTransferInput {
  transferDate: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  fromBankAccountId: string;
  toBankAccountId: string;
  amount: string;
  /** Required when neither bank account is restricted to a currency. */
  currency?: string | null;
  memo?: string | null;
  reason: string;
  idempotencyKey?: string | null;
}

export interface FundTransferDetail {
  id: string;
  transferNumber: string;
  transferDate: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  fromBankAccountId: string;
  toBankAccountId: string;
  currency: string;
  amount: string;
  memo: string | null;
  reason: string;
  status: "posted" | "reversed";
  entryId: string;
  reversalEntryId: string | null;
  reversalDate: string | null;
  reverseReason: string | null;
  createdBy: string;
  createdAt: string;
}

const FEATURE = "intercompanyNetting";

function refuse(message: string, status: 404 | 409 | 422 = 422): never {
  throw new IntercompanyError(message, status);
}

function scopeAllows(allowed: ReadonlySet<string> | null, ids: string[]): boolean {
  return allowed === null || ids.every((id) => allowed.has(id));
}

function validate(input: FundTransferInput): FundTransferInput & { amount: string } {
  if (!isIsoCalendarDate(input.transferDate))
    refuse("the transfer date must be a valid calendar date (YYYY-MM-DD)");
  for (const [value, label] of [
    [input.fromSubsidiaryId, "paying subsidiary"],
    [input.toSubsidiaryId, "receiving subsidiary"],
    [input.fromBankAccountId, "paying bank account"],
    [input.toBankAccountId, "receiving bank account"],
  ] as const) {
    if (!isUuid(value)) refuse(`choose the ${label}`);
  }
  if (input.fromSubsidiaryId === input.toSubsidiaryId) {
    refuse(
      "both bank accounts belong to the same subsidiary; record a bank transfer in Banking instead",
    );
  }
  const exact = canonicalDecimal(input.amount, 4);
  if (exact === null || toUnits(exact) <= 0n || wholeDigits(exact) > 15)
    refuse("the amount must be a positive amount with at most four decimals");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) refuse("a reason is required");
  if (reason.length > 2000) refuse("the reason must be at most 2000 characters");
  const memo =
    typeof input.memo === "string" && input.memo.trim() ? input.memo.trim().slice(0, 500) : null;
  if (input.currency != null && !/^[A-Z]{3}$/.test(input.currency))
    refuse("the currency must be a three-letter code");
  return { ...input, amount: parseMoney(exact), reason, memo };
}

/** Post a transfer between two entities' bank accounts. Idempotent per key. */
export async function postIntercompanyFundTransfer(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  raw: FundTransferInput,
): Promise<FundTransferDetail> {
  const input = validate(raw);
  if (!scopeAllows(allowedSubsidiaryIds, [input.fromSubsidiaryId, input.toSubsidiaryId])) {
    refuse("a chosen subsidiary is outside your visible subsidiaries", 404);
  }
  const id = await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.settle");
    if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) refuse(INTERCOMPANY_NETTING_DISABLED);
    if (input.idempotencyKey) {
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`intercompany-transfer:${orgId}:${input.idempotencyKey}`}, 0))`,
      );
      const prior = (
        await db.execute<{
          id: string;
          status: "posted" | "reversed";
          from_bank_account_id: string;
          to_bank_account_id: string;
          amount: string;
          transfer_date: string;
          from_subsidiary_id: string;
          to_subsidiary_id: string;
          currency: string;
          memo: string | null;
          reason: string;
        }>(
          sql`
        select id, status, from_bank_account_id, to_bank_account_id, amount::text as amount, transfer_date::text as transfer_date,
               from_subsidiary_id, to_subsidiary_id, currency, memo, reason
          from intercompany_fund_transfers
         where org_id = ${orgId} and idempotency_key = ${input.idempotencyKey}`,
          "objects",
        )
      )[0];
      if (prior) {
        const same =
          prior.from_bank_account_id === input.fromBankAccountId &&
          prior.to_bank_account_id === input.toBankAccountId &&
          prior.from_subsidiary_id === input.fromSubsidiaryId &&
          prior.to_subsidiary_id === input.toSubsidiaryId &&
          toUnits(prior.amount) === toUnits(input.amount) &&
          prior.transfer_date === input.transferDate &&
          (input.currency == null || prior.currency === input.currency) &&
          prior.memo === (input.memo ?? null) &&
          prior.reason === input.reason;
        if (!same)
          refuse(
            "this request key already recorded a different transfer; use a new key for a new transfer",
            409,
          );
        if (prior.status === "reversed") {
          refuse(
            "this transfer has already been reversed; use a new request key to record a new transfer",
            409,
          );
        }
        return prior.id;
      }
    }
    const accounts = await db.execute<{
      id: string;
      name: string;
      type: string;
      is_active: boolean;
      is_summary: boolean;
      currency_restriction: string | null;
    }>(
      sql`
      select id, name, type, is_active, is_summary, currency_restriction from accounts
       where org_id = ${orgId} and id in (${input.fromBankAccountId}, ${input.toBankAccountId})`,
      "objects",
    );
    const from = accounts.find((account) => account.id === input.fromBankAccountId);
    const to = accounts.find((account) => account.id === input.toBankAccountId);
    if (!from || !to) refuse("a chosen bank account does not exist in this organization", 404);
    for (const account of [from, to]) {
      if (account.type !== "asset_bank" || !account.is_active || account.is_summary) {
        refuse(`${account.name} is not an active bank account`);
      }
    }
    const restrictions = [
      ...new Set(
        [from.currency_restriction, to.currency_restriction].filter((c): c is string => Boolean(c)),
      ),
    ];
    if (restrictions.length > 1) {
      refuse(
        `${from.name} holds ${from.currency_restriction} and ${to.name} holds ${to.currency_restriction}; an intercompany transfer moves one currency — choose accounts in the same currency`,
      );
    }
    const currency = restrictions[0] ?? input.currency ?? null;
    if (!currency)
      refuse("choose the transfer currency; neither bank account is restricted to one");
    if (input.currency && input.currency !== currency)
      refuse(`the chosen bank accounts hold ${currency}, not ${input.currency}`);

    const pair = await loadIntercompanyPair(
      db,
      orgId,
      input.fromSubsidiaryId,
      input.toSubsidiaryId,
    );
    if (!pair || !pair.isActive) {
      refuse(
        "no active intercompany pair joins these subsidiaries; configure one under Setup → Accounting → Intercompany pairs",
      );
    }
    const ctx = await loadSubsidiaryContext(db, orgId);
    const fromSub = ctx.byId.get(input.fromSubsidiaryId);
    const toSub = ctx.byId.get(input.toSubsidiaryId);
    if (!fromSub || !toSub) refuse("a chosen subsidiary does not exist in this organization", 404);
    const bookId = await intercompanyPostingBook(db, orgId);
    const periodId = await intercompanyPostingPeriod(
      db,
      orgId,
      input.transferDate,
      input.fromSubsidiaryId,
    );
    await assertIntercompanyPeriodsOpen(db, {
      orgId,
      date: input.transferDate,
      bookId,
      subsidiaryIds: [input.fromSubsidiaryId, input.toSubsidiaryId],
      modules: ["banking"],
    });
    const rates = await resolveSpotRates(db, orgId, input.transferDate, [
      { from: currency, to: fromSub.baseCurrency },
      { from: currency, to: toSub.baseCurrency },
    ]);
    const fromRate = normalizeDecimal(rates.get(`${currency}>${fromSub.baseCurrency}`)!, 10);
    const toRate = normalizeDecimal(rates.get(`${currency}>${toSub.baseCurrency}`)!, 10);
    const memo = input.memo ?? `Intercompany transfer to ${toSub.name}`;
    const bankLines: SubLine[] = [
      {
        accountId: input.fromBankAccountId,
        subsidiaryId: input.fromSubsidiaryId,
        amount: spotTranslation(neg(input.amount), fromRate),
        txnAmount: neg(input.amount),
        currency,
        fxRate: fromRate,
      },
      {
        accountId: input.toBankAccountId,
        subsidiaryId: input.toSubsidiaryId,
        amount: spotTranslation(input.amount, toRate),
        txnAmount: input.amount,
        currency,
        fxRate: toRate,
      },
    ];
    let legs;
    try {
      legs = await intercompanyBalancingLegs(db, {
        orgId,
        ctx,
        originSubId: input.fromSubsidiaryId,
        originFxRate: fromRate,
        lines: bankLines,
      });
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx,
        docSubsidiaryId: input.fromSubsidiaryId,
        lines: [
          ...bankLines,
          ...legs.map((leg) => ({
            accountId: leg.accountId,
            amount: leg.amount,
            subsidiaryId: leg.subsidiaryId,
          })),
        ],
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) refuse(error.message);
      throw error;
    }
    const transferNumber = await allocateDocumentNumber(db, orgId, "intercompany_transfer", "ICT-");
    let posted: PostEntryResult;
    try {
      posted = await postEntry(db, {
        orgId,
        bookId,
        subsidiaryId: input.fromSubsidiaryId,
        entryNumber: transferNumber,
        postingDate: input.transferDate,
        periodId,
        memo,
        origin: "intercompany",
        custom: { intercompanyTransfer: transferNumber },
        actorId,
        idempotencyKey: input.idempotencyKey
          ? `intercompany-transfer:${input.idempotencyKey}`
          : undefined,
        closeModules: ["banking"],
        lines: [
          ...bankLines.map((line) => ({
            accountId: line.accountId,
            subsidiaryId: line.subsidiaryId,
            amount: line.amount,
            currency: line.currency,
            txnAmount: line.txnAmount,
            fxRate: line.fxRate,
            memo,
          })),
          ...legs.map((leg) => ({
            accountId: leg.accountId,
            subsidiaryId: leg.subsidiaryId,
            amount: leg.amount,
            currency: leg.currency,
            txnAmount: leg.txnAmount,
            fxRate: leg.fxRate,
            memo: leg.memo,
          })),
        ],
      });
    } catch (error) {
      intercompanyPostingRefusal(error);
    }
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into intercompany_fund_transfers
        (org_id, transfer_number, transfer_date, from_subsidiary_id, to_subsidiary_id, from_bank_account_id,
         to_bank_account_id, currency, amount, memo, reason, entry_id, idempotency_key, created_by)
      values (${orgId}, ${transferNumber}, ${input.transferDate}, ${input.fromSubsidiaryId}, ${input.toSubsidiaryId},
              ${input.fromBankAccountId}, ${input.toBankAccountId}, ${currency}, ${input.amount}, ${input.memo ?? null},
              ${input.reason}, ${posted.entryId}, ${input.idempotencyKey ?? null}, ${actorId})
      returning id`,
      "objects",
    );
    requireOneRow(inserted, "the transfer could not be recorded");
    const transferId = inserted[0]!.id;
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_fund_transfers",
      rowId: transferId,
      action: "insert",
      actorId,
      changes: {
        mode: "intercompany_transfer_posted",
        reason: input.reason,
        after: {
          transferNumber,
          transferDate: input.transferDate,
          currency,
          amount: input.amount,
          entryId: posted.entryId,
        },
      },
    });
    return transferId;
  });
  return loadIntercompanyFundTransfer(orgId, id, allowedSubsidiaryIds);
}

/** Reverse a posted transfer on a date with a reason. Idempotent. */
export async function reverseIntercompanyFundTransfer(
  orgId: string,
  actorId: string,
  transferId: string,
  input: { reversalDate: string; reason: string },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<FundTransferDetail> {
  if (!isIsoCalendarDate(input.reversalDate))
    refuse("the reversal date must be a valid calendar date (YYYY-MM-DD)");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) refuse("a reversal reason is required");
  if (!isUuid(transferId)) refuse("transfer not found", 404);
  await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.settle");
    if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) refuse(INTERCOMPANY_NETTING_DISABLED);
    const transfer = (
      await db.execute<{
        status: string;
        entry_id: string;
        transfer_number: string;
        transfer_date: string;
        from_subsidiary_id: string;
        to_subsidiary_id: string;
      }>(
        sql`
      select status, entry_id, transfer_number, transfer_date::text as transfer_date, from_subsidiary_id, to_subsidiary_id
        from intercompany_fund_transfers
       where org_id = ${orgId} and id = ${transferId}
       for update`,
        "objects",
      )
    )[0];
    if (
      !transfer ||
      !scopeAllows(allowedSubsidiaryIds, [transfer.from_subsidiary_id, transfer.to_subsidiary_id])
    ) {
      refuse("transfer not found", 404);
    }
    if (transfer.status === "reversed") return;
    if (input.reversalDate < transfer.transfer_date)
      refuse(`the reversal date cannot be before the transfer date ${transfer.transfer_date}`);
    const bookId = await intercompanyPostingBook(db, orgId);
    const periodId = await intercompanyPostingPeriod(
      db,
      orgId,
      input.reversalDate,
      transfer.from_subsidiary_id,
    );
    await assertIntercompanyPeriodsOpen(db, {
      orgId,
      date: input.reversalDate,
      bookId,
      subsidiaryIds: [transfer.from_subsidiary_id, transfer.to_subsidiary_id],
      modules: ["banking"],
    });
    const reversalEntryId = await postMirrorReversal(db, {
      orgId,
      entryId: transfer.entry_id,
      entryNumber: `${transfer.transfer_number}-R`,
      postingDate: input.reversalDate,
      periodId,
      memo: `Reversal of intercompany transfer ${transfer.transfer_number}: ${reason}`,
      actorId,
      idempotencyKey: `intercompany-transfer-reversal:${transferId}`,
      custom: { intercompanyTransfer: transfer.transfer_number, reversal: true },
      closeModules: ["banking"],
    });
    const updated = await db.execute<{ id: string }>(
      sql`
      update intercompany_fund_transfers
         set status = 'reversed', reversal_entry_id = ${reversalEntryId}, reversal_date = ${input.reversalDate},
             reverse_reason = ${reason}, reversed_by = ${actorId}, reversed_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${transferId} and status = 'posted'
      returning id`,
      "objects",
    );
    requireOneRow(updated, "the transfer changed while it was being reversed");
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_fund_transfers",
      rowId: transferId,
      action: "update",
      actorId,
      changes: {
        mode: "intercompany_transfer_reversed",
        reason,
        before: { status: "posted" },
        after: { status: "reversed", reversalDate: input.reversalDate, reversalEntryId },
      },
    });
  });
  return loadIntercompanyFundTransfer(orgId, transferId, allowedSubsidiaryIds);
}

export async function loadIntercompanyFundTransfer(
  orgId: string,
  transferId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<FundTransferDetail> {
  if (!isUuid(transferId)) refuse("transfer not found", 404);
  const row = (
    await db.execute<{
      id: string;
      transfer_number: string;
      transfer_date: string;
      from_subsidiary_id: string;
      to_subsidiary_id: string;
      from_bank_account_id: string;
      to_bank_account_id: string;
      currency: string;
      amount: string;
      memo: string | null;
      reason: string;
      status: "posted" | "reversed";
      entry_id: string;
      reversal_entry_id: string | null;
      reversal_date: string | null;
      reverse_reason: string | null;
      created_by: string;
      created_at: string;
    }>(
      sql`
    select id, transfer_number, transfer_date::text as transfer_date, from_subsidiary_id, to_subsidiary_id,
           from_bank_account_id, to_bank_account_id, currency, amount::text as amount, memo, reason, status,
           entry_id, reversal_entry_id, reversal_date::text as reversal_date, reverse_reason, created_by,
           created_at::text as created_at
      from intercompany_fund_transfers
     where org_id = ${orgId} and id = ${transferId}`,
      "objects",
    )
  )[0];
  if (!row || !scopeAllows(allowedSubsidiaryIds, [row.from_subsidiary_id, row.to_subsidiary_id]))
    refuse("transfer not found", 404);
  return {
    id: row.id,
    transferNumber: row.transfer_number,
    transferDate: row.transfer_date,
    fromSubsidiaryId: row.from_subsidiary_id,
    toSubsidiaryId: row.to_subsidiary_id,
    fromBankAccountId: row.from_bank_account_id,
    toBankAccountId: row.to_bank_account_id,
    currency: row.currency,
    amount: row.amount,
    memo: row.memo,
    reason: row.reason,
    status: row.status,
    entryId: row.entry_id,
    reversalEntryId: row.reversal_entry_id,
    reversalDate: row.reversal_date,
    reverseReason: row.reverse_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Transfers the caller can see in full (both entities in scope), newest first. */
export async function listIntercompanyFundTransfers(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: { limit?: number } = {},
): Promise<FundTransferDetail[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const allowed = allowedSubsidiaryIds === null ? null : [...allowedSubsidiaryIds];
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from intercompany_fund_transfers
     where org_id = ${orgId}
       and (${allowed === null}::boolean
            or (from_subsidiary_id = any(${uuidArray(allowed ?? [])}::uuid[])
                and to_subsidiary_id = any(${uuidArray(allowed ?? [])}::uuid[])))
     order by transfer_date desc, transfer_number desc
     limit ${limit}`,
    "objects",
  );
  const out: FundTransferDetail[] = [];
  for (const row of rows)
    out.push(await loadIntercompanyFundTransfer(orgId, row.id, allowedSubsidiaryIds));
  return out;
}
