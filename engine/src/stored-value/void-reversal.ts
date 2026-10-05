import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits } from "../money/money.ts";
import { insertStoredValueEntry, lockStoredValueAccount, priorStoredValueEntry } from "./accounts.ts";
import { storedValueRefusal } from "./errors.ts";

type DocumentEffect = {
  id: string;
  accountId: string;
  kind: "issue" | "redeem" | "adjust";
  amountMinor: string;
  functionalAmountMinor: string;
  fxRate: string;
  documentLineId: string | null;
};

const voidReversalKey = (entryId: string) => `stored-value:void-reversal:${entryId}`;

/**
 * Undo, in the void's own transaction, every stored-value effect a document
 * had: a receipt's gift-card redemptions return to their cards, and a sale or
 * refund that issued or loaded value takes it back. The document's journal
 * carried the liability legs, so the void's GL reversal already moved the
 * ledger; this moves the subledger to match with one 'reversal' entry per
 * effect, keyed by the effect it reverses so a retried void never reverses
 * twice.
 *
 * Refuses by name when the card can no longer take the reversal: value the
 * customer has already spent cannot be taken back, and a card that has since
 * expired or closed cannot have value returned to it.
 */
export async function reverseStoredValueForVoidedDocument(input: {
  orgId: string;
  documentId: string;
  documentNumber: string;
  reversalEntryId: string | null;
  actorId: string;
  reason: string;
}): Promise<{ reversed: number }> {
  const effects = (await db.execute<DocumentEffect>(sql`
    select entry.id, entry.account_id as "accountId", entry.kind,
           entry.amount_minor::text as "amountMinor",
           entry.functional_amount_minor::text as "functionalAmountMinor",
           entry.fx_rate::text as "fxRate", entry.document_line_id as "documentLineId"
      from stored_value_entries entry
     where entry.org_id = ${input.orgId} and entry.document_id = ${input.documentId}
       and entry.kind in ('issue', 'redeem', 'adjust')
     order by entry.account_id, entry.created_at, entry.id
  `)).rows;
  if (effects.length === 0) return { reversed: 0 };
  const byAccount = new Map<string, DocumentEffect[]>();
  for (const effect of effects) byAccount.set(effect.accountId, [...(byAccount.get(effect.accountId) ?? []), effect]);
  let reversed = 0;
  // Accounts lock in id order, like split-tender redemption, so concurrent
  // voids and redemptions of the same cards cannot deadlock.
  for (const accountId of [...byAccount.keys()].sort()) {
    const account = await lockStoredValueAccount(input.orgId, accountId);
    let balance = account.balanceMinor;
    let issued = account.issuedMinor;
    const pending: Array<{ effect: DocumentEffect; amountMinor: bigint; balanceAfter: bigint }> = [];
    for (const effect of byAccount.get(accountId)!) {
      const prior = await priorStoredValueEntry(input.orgId, voidReversalKey(effect.id), {
        accountId,
        kind: "reversal",
        amountMinor: -BigInt(effect.amountMinor),
      });
      if (prior) continue;
      const amountMinor = -BigInt(effect.amountMinor);
      const label = `…${account.codeLast4}`;
      if (amountMinor > 0n && (account.status === "expired" || account.status === "closed")) {
        throw storedValueRefusal({
          message: `Stored-value ${label} is ${account.status}; voiding ${input.documentNumber} would return ${fromUnits(amountMinor)} to a card that can no longer be used.`,
          code: "stored_value_void_card_ended",
          remedy: `Leave ${input.documentNumber} posted; if the customer is owed the value, issue a replacement card for it.`,
          status: 409,
        });
      }
      if (balance + amountMinor < 0n) {
        throw storedValueRefusal({
          message: `Stored-value ${label} holds ${fromUnits(balance)}, less than the ${fromUnits(-amountMinor)} ${input.documentNumber} put on it; voiding would take back value already spent.`,
          code: "stored_value_void_value_spent",
          remedy: `Leave ${input.documentNumber} posted and correct the card's unspent balance with a stored-value adjustment instead.`,
          status: 409,
        });
      }
      balance += amountMinor;
      if (effect.kind === "issue") issued += amountMinor;
      pending.push({ effect, amountMinor, balanceAfter: balance });
    }
    if (pending.length === 0) continue;
    // A card this document minted dies with it once nothing is left on it.
    const closes = account.sourceDocumentId === input.documentId && balance === 0n
      && (account.status === "active" || account.status === "frozen");
    const updated = (await db.execute<{ id: string }>(sql`
      update stored_value_accounts
         set balance_minor = ${balance.toString()},
             issued_minor = ${(issued < 0n ? 0n : issued).toString()},
             status = ${closes ? "closed" : account.status},
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${accountId}
         and balance_minor = ${account.balanceMinor.toString()} and status = ${account.status}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw storedValueRefusal({
        message: `Stored-value …${account.codeLast4} changed while ${input.documentNumber} was being voided.`,
        code: "stored_value_balance_changed",
        remedy: "Retry the void.",
        status: 409,
      });
    }
    for (const { effect, amountMinor, balanceAfter } of pending) {
      const entry = await insertStoredValueEntry(input.orgId, {
        accountId,
        kind: "reversal",
        amountMinor,
        balanceAfter,
        currency: account.currency,
        functionalAmountMinor: -BigInt(effect.functionalAmountMinor),
        fxRate: effect.fxRate,
        documentId: input.documentId,
        documentLineId: effect.documentLineId,
        journalEntryId: input.reversalEntryId,
        idempotencyKey: voidReversalKey(effect.id),
        reason: `void of ${input.documentNumber}: ${input.reason}`,
        actorId: input.actorId,
      });
      // The balance above already moved, so this entry must be fresh: a
      // concurrent writer under the same key rolls the whole void back.
      if (entry.replayed) {
        throw storedValueRefusal({
          message: `Another request reversed ${input.documentNumber}'s effect on …${account.codeLast4} while this void was applying it.`,
          code: "stored_value_idempotency_conflict",
          remedy: "Retry the void; it finds the reversal already recorded.",
          status: 409,
        });
      }
      reversed++;
    }
    if (closes) {
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${input.orgId}, 'stored_value_accounts', ${accountId}, 'update', ${JSON.stringify({
          event: "stored_value_status_changed",
          before: { status: account.status },
          after: { status: "closed" },
          reason: `void of ${input.documentNumber}: ${input.reason}`,
        })}::jsonb, ${input.actorId})
      `);
    }
  }
  return { reversed };
}
