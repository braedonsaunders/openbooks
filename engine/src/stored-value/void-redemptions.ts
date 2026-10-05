import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import {
  insertStoredValueEntry,
  lockStoredValueAccount,
  postingContext,
  priorStoredValueEntry,
} from "./accounts.ts";
import { storedValueRefusal } from "./errors.ts";

/**
 * Void unwind for stored-value redemptions. Voiding a document that spent a
 * gift card or store credit must give the money back: the redemption was a
 * posted subledger movement, so the void appends a `reversal` entry that
 * restores the balance — never edits or deletes the redeem entry — and
 * reverses the realized-FX journal the redemption priced, so no phantom
 * gain or loss survives a sale that never happened. The document's own
 * journal (with the liability relief leg) is reversed by the void flow
 * itself; this covers the subledger and the repricing beside it.
 *
 * Idempotent per redemption: a retried void finds the first reversal entry
 * and the already-reversed FX entry instead of restoring twice.
 */

type RedeemRow = {
  id: string;
  accountId: string;
  amountMinor: string;
  functionalAmountMinor: string;
  currency: string;
  fxRate: string;
  idempotencyKey: string;
  codeLast4: string;
};

const REDEEM_PREFIX = "stored-value:redeem-entry:";
const REVERSAL_PREFIX = "stored-value:redeem-reversal-entry:";
const REALIZED_PREFIX = "stored-value:realized:";

function reversalSuffix(idempotencyKey: string): string {
  return idempotencyKey.startsWith(REDEEM_PREFIX)
    ? idempotencyKey.slice(REDEEM_PREFIX.length)
    : idempotencyKey;
}

/** Mirror a posted realized-FX entry back into the ledger, then mark it reversed — never edited. */
async function reverseRealizedFxEntry(input: {
  orgId: string;
  realizedEntryId: string;
  reversalKey: string;
  postingDate: string;
  subsidiaryId: string;
  memo: string;
  actorId: string;
}): Promise<string | null> {
  const source = (
    await db.execute<{
      id: string;
      status: string;
      book_id: string;
      subsidiary_id: string;
      entry_number: string;
      origin: string;
    }>(sql`
      select id, status, book_id, subsidiary_id, entry_number, origin
        from journal_entries
       where org_id = ${input.orgId} and id = ${input.realizedEntryId}
       for update
    `)
  ).rows[0];
  if (!source) {
    throw storedValueRefusal({
      message: "A realized FX entry for this redemption is missing — the ledger no longer balances the card.",
      code: "stored_value_realized_missing",
      remedy: "Have an accountant post a manual FX correction to the liability account, then void again.",
      status: 409,
    });
  }
  // A retried void finds the first reversal instead of unwinding twice.
  if (source.status !== "posted") return null;
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(and(eq(schema.journalLines.entryId, source.id), eq(schema.journalLines.orgId, input.orgId)));
  const mirror = reversalJournalLines(lines, { entryId: "", orgId: input.orgId });
  const context = await postingContext(db, input.orgId, input.postingDate, input.subsidiaryId);
  const posted = await postEntry(db, {
    orgId: input.orgId,
    bookId: context.bookId,
    subsidiaryId: context.subsidiaryId,
    entryNumber: await db.transaction((tx) =>
      nextFreeEntryNumber(tx, input.orgId, `SV-REALIZED-${source.entry_number}-VOID`),
    ),
    postingDate: input.postingDate,
    periodId: context.periodId,
    memo: input.memo,
    origin: source.origin,
    reversesEntryId: source.id,
    idempotencyKey: `stored-value:realized-reversal:${input.reversalKey}`,
    actorId: input.actorId,
    auditAction: "create",
    auditChanges: { reversedEntryId: source.id, reason: "document_void" },
    lines: mirror.map((line) => ({
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      amount: line.amount,
      currency: line.currency,
      txnAmount: line.txnAmount,
      fxRate: line.fxRate,
      memo: line.memo,
      partyId: line.partyId,
      departmentId: line.departmentId,
      projectId: line.projectId,
      locationId: line.locationId,
      classId: line.classId,
      equipmentUnitId: line.equipmentUnitId,
      extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
      paymentCardId: line.paymentCardId,
      taxCodeId: line.taxCodeId,
      quantity: line.quantity,
      unit: line.unit,
      custom: (line.custom ?? {}) as Record<string, unknown>,
      contributorKind: line.contributorKind,
      contributorRef: line.contributorRef,
      lineNumber: line.lineNumber,
    })),
  });
  await markEntryReversed(db, { orgId: input.orgId, entryId: source.id, actorId: input.actorId });
  return posted.entryId;
}

export async function reverseRedemptionsForVoidedDocument(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  reversalDate: string;
  reason: string;
}): Promise<{ reversed: number; realizedReversed: number }> {
  const redeems = (
    await db.execute<RedeemRow>(sql`
      select e.id, e.account_id as "accountId", e.amount_minor::text as "amountMinor",
             e.functional_amount_minor::text as "functionalAmountMinor",
             e.currency, e.fx_rate::text as "fxRate", e.idempotency_key as "idempotencyKey",
             a.code_last4 as "codeLast4"
        from stored_value_entries e
        join stored_value_accounts a on a.org_id = e.org_id and a.id = e.account_id
       where e.org_id = ${input.orgId} and e.document_id = ${input.documentId} and e.kind = 'redeem'
       order by e.account_id, e.id
    `)
  ).rows;
  let reversed = 0;
  let realizedReversed = 0;
  for (const redeem of redeems) {
    const suffix = reversalSuffix(redeem.idempotencyKey);
    const reversalKey = `${REVERSAL_PREFIX}${suffix}`;
    const restoredMinor = -BigInt(redeem.amountMinor);
    // Checked under no lock yet: a prior void already restored this slice,
    // so only its realized FX may still need unwinding below.
    const prior = await priorStoredValueEntry(input.orgId, reversalKey, {
      accountId: redeem.accountId,
      kind: "reversal",
      amountMinor: restoredMinor,
    });
    if (!prior) {
      // Account locks sort by id (the single-account unit needs no sort,
      // and redeems arrive in account order) so concurrent voids serialize.
      const account = await lockStoredValueAccount(input.orgId, redeem.accountId);
      if (account.status === "closed") {
        throw storedValueRefusal({
          message: `Stored-value …${account.codeLast4} is closed, so voiding its redemption cannot restore the balance.`,
          code: "stored_value_account_closed",
          remedy: "Reopen the account from the Stored value list, then void again.",
          status: 409,
        });
      }
      const balanceMinor = account.balanceMinor + restoredMinor;
      const updated = (
        await db.execute<{ id: string }>(sql`
          update stored_value_accounts
             set balance_minor = ${balanceMinor.toString()},
                 last_activity_on = CURRENT_DATE,
                 updated_at = now(), updated_by = ${input.actorId}
           where org_id = ${input.orgId} and id = ${account.id}
             and balance_minor = ${account.balanceMinor.toString()}
          returning id
        `)
      ).rows;
      if (updated.length !== 1) {
        throw storedValueRefusal({
          message: `Stored-value …${account.codeLast4} changed while voiding; the reversal cannot be measured.`,
          code: "stored_value_balance_changed",
          remedy: "Retry the void.",
          status: 409,
        });
      }
      const entry = await insertStoredValueEntry(input.orgId, {
        accountId: account.id,
        kind: "reversal",
        amountMinor: restoredMinor,
        balanceAfter: balanceMinor,
        currency: redeem.currency,
        // The slice returns at exactly the carrying value it relieved, so
        // the functional remainder keeps tying to the ledger liability.
        functionalAmountMinor: -BigInt(redeem.functionalAmountMinor),
        fxRate: redeem.fxRate,
        documentId: input.documentId,
        journalEntryId: null,
        idempotencyKey: reversalKey,
        reason: `Void: ${input.reason}`,
        actorId: input.actorId,
      });
      if (entry.replayed) {
        throw storedValueRefusal({
          message: `Another request reversed redemption …${account.codeLast4} while this void was applying it.`,
          code: "stored_value_idempotency_conflict",
          remedy: "Retry the void unchanged; it returns the reversal that was recorded.",
          status: 409,
        });
      }
      reversed += 1;
    }
    // The realized entry stamps its exactly-once key into custom (the
    // journal's partial unique index), never a header column.
    const realized = (
      await db.execute<{ id: string }>(sql`
        select id from journal_entries
         where org_id = ${input.orgId} and custom->>'idempotencyKey' = ${`${REALIZED_PREFIX}${suffix}`}
      `)
    ).rows[0];
    if (realized) {
      const account = await lockStoredValueAccount(input.orgId, redeem.accountId);
      const undone = await reverseRealizedFxEntry({
        orgId: input.orgId,
        realizedEntryId: realized.id,
        reversalKey: suffix,
        postingDate: input.reversalDate,
        subsidiaryId: account.subsidiaryId,
        memo: `Reversal: ${input.reason}`,
        actorId: input.actorId,
      });
      if (undone) realizedReversed += 1;
    }
  }
  return { reversed, realizedReversed };
}
