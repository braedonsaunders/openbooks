import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { attachDocumentIssue, loadStoredValueProgram } from "./accounts.ts";
import { storedValueRefusal } from "./errors.ts";

interface GiftCardLine {
  id: string;
  amount: string;
  currency: string;
  programId: string | null;
  description: string | null;
}

/**
 * Post-commit issue for gift card sales. The invoice's own journal already
 * posted CR liability (the posting rule routes gift card lines there), so
 * this mints one redeemable account per line and points its issue entry at
 * that journal. Idempotent per document line: a retried effect replays the
 * first write instead of minting a second code.
 */
export async function issueStoredValueForInvoice(
  documentId: string,
  orgId: string,
  actorId: string | null,
): Promise<{ issued: number }> {
  const doc = (await db.execute<{ id: string; status: string; currency: string; entryId: string | null }>(sql`
    select id, status, currency, posted_entry_id as "entryId"
      from documents where id = ${documentId} and org_id = ${orgId}
  `)).rows[0];
  if (!doc || doc.status !== "posted") return { issued: 0 };
  if (!doc.entryId) {
    throw storedValueRefusal({
      message: "The posted sale has no journal entry; gift card accounts cannot attach to it.",
      code: "stored_value_sale_journal_missing",
      remedy: "Repost the sale, then let the posting effect retry.",
    });
  }
  const lines = (await db.execute<GiftCardLine>(sql`
    select dl.id, dl.amount::text as amount, dl.custom->>'storedValueProgramId' as "programId",
           dl.description as description, d.currency as currency
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      join items it on it.id = dl.item_id and it.org_id = dl.org_id
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
       and it.kind = 'gift_card'
     order by dl.line_number
  `)).rows;
  if (lines.length === 0) return { issued: 0 };
  let issued = 0;
  for (const line of lines) {
    if (!line.programId) {
      throw storedValueRefusal({
        message: `Gift card line "${line.description ?? line.id}" names no issuing program.`,
        code: "stored_value_sale_program_missing",
        remedy: "Set the gift card program on the sale line, then repost the sale.",
      });
    }
    const program = await loadStoredValueProgram(orgId, line.programId);
    if (program.kind !== "gift_card") {
      throw storedValueRefusal({
        message: `The ${program.name} program issues ${program.kind === "store_credit" ? "store credit" : program.kind}, not gift cards.`,
        code: "stored_value_sale_program_kind",
        remedy: "Set a gift card program on the sale line, then repost the sale.",
      });
    }
    let amountMinor: bigint;
    try {
      amountMinor = toUnits(line.amount);
    } catch {
      throw storedValueRefusal({
        message: `Gift card line "${line.description ?? line.id}" carries an unreadable amount.`,
        code: "stored_value_sale_amount_invalid",
        remedy: "Correct the line amount and repost the sale.",
      });
    }
    if (amountMinor <= 0n) {
      throw storedValueRefusal({
        message: `Gift card line "${line.description ?? line.id}" must be positive; refunds leave through a credit memo.`,
        code: "stored_value_sale_amount_nonpositive",
        remedy: "Refund the gift card through a customer credit memo instead.",
      });
    }
    await attachDocumentIssue({
      orgId,
      programId: program.id,
      amountMinor,
      currency: line.currency,
      sourceDocumentId: documentId,
      sourceLineId: line.id,
      journalEntryId: doc.entryId,
      idempotencyKey: `sv-sale:${documentId}:${line.id}`,
      actorId,
    });
    issued++;
  }
  return { issued };
}

/**
 * Post-commit issue for a "refund to store credit" credit memo. The memo's
 * own journal already posted CR store-credit liability (the posting rule
 * swaps the AR leg when the memo carries a program), so this mints the
 * customer account pointing at that journal. One account per memo.
 */
export async function issueStoreCreditForCreditMemo(
  documentId: string,
  orgId: string,
  actorId: string | null,
): Promise<{ issued: number }> {
  const doc = (await db.execute<{
    id: string; status: string; currency: string; total: string;
    partyId: string | null; entryId: string | null; custom: unknown;
  }>(sql`
    select id, status, currency, total::text as total, party_id as "partyId",
           posted_entry_id as "entryId", custom
      from documents where id = ${documentId} and org_id = ${orgId}
  `)).rows[0];
  if (!doc || doc.status !== "posted") return { issued: 0 };
  const programId =
    doc.custom && typeof doc.custom === "object"
      ? (doc.custom as Record<string, unknown>)["storeCreditProgramId"]
      : null;
  if (typeof programId !== "string" || !programId) return { issued: 0 };
  if (!doc.entryId) {
    throw storedValueRefusal({
      message: "The posted credit memo has no journal entry; the store credit cannot attach to it.",
      code: "stored_value_credit_journal_missing",
      remedy: "Repost the credit memo, then let the posting effect retry.",
    });
  }
  if (!doc.partyId) {
    throw storedValueRefusal({
      message: "Store credit is issued to a customer; the credit memo names none.",
      code: "stored_value_store_credit_customer_missing",
      remedy: "Select the customer on the credit memo, then repost it.",
    });
  }
  const program = await loadStoredValueProgram(orgId, programId);
  if (program.kind !== "store_credit" || !program.isActive) {
    throw storedValueRefusal({
      message: `The ${program.name} program cannot issue store credit.`,
      code: "stored_value_credit_program_kind",
      remedy: "Choose an active store credit program on the credit memo, then repost it.",
    });
  }
  let amountMinor: bigint;
  try {
    amountMinor = toUnits(doc.total);
  } catch {
    throw storedValueRefusal({
      message: "The credit memo carries an unreadable total.",
      code: "stored_value_credit_amount_invalid",
      remedy: "Correct the memo total and repost it.",
    });
  }
  if (amountMinor <= 0n) return { issued: 0 };
  await attachDocumentIssue({
    orgId,
    programId: program.id,
    amountMinor,
    currency: doc.currency,
    customerPartyId: doc.partyId,
    sourceDocumentId: documentId,
    journalEntryId: doc.entryId,
    idempotencyKey: `sv-credit:${documentId}`,
    actorId,
  });
  return { issued: 1 };
}
