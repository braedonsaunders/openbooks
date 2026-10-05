import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { addMonthsClamped, isIsoCalendarDate } from "../platform/civil-date.ts";
import {
  functionalMinor,
  loadDocumentFxContext,
  resolveEventRate,
  subsidiaryBaseCurrency,
  type DocumentFxContext,
} from "./fx-amounts.ts";
import {
  insertStoredValueEntry,
  loadStoredValueProgram,
  lockStoredValueAccount,
  programLiabilityAccount,
  requireStoredValueFeature,
  storedValueAccountOwnedByCustomer,
} from "./accounts.ts";
import {
  codeLast4,
  generateStoredValueCode,
  hashStoredValueCode,
} from "./codes.ts";
import { storedValueRefusal } from "./errors.ts";

export interface DocumentLoadInput {
  orgId: string;
  /** REQUIRED actor scope; posting-commit steps name explicit null outright as the unrestricted grant — the refund document's entity was gated at draft creation and the top-up asserts it matches. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  /** Existing account to top up. Absent mints one from programId. */
  accountId?: string | null;
  /** Issuing program for the mint path. Must be an active store_credit program. */
  programId?: string | null;
  customerPartyId?: string | null;
  /** Minor units, must be positive. */
  amountMinor: bigint;
  currency: string;
  documentId: string;
  /** The caller's posted journal, which already carries the liability leg. */
  journalEntryId: string;
  idempotencyKey: string;
  actorId?: string | null;
}

export interface DocumentLoadResult {
  accountId: string;
  /** Plaintext code for a minted account, shown once and never stored. */
  code: string | null;
  entryId: string;
  replayed: boolean;
}

/**
 * Credit stored value from a document whose own journal already moved the
 * liability (a cash refund paid to store credit): top up the named account,
 * or mint one from the program when the customer has none yet. The caller
 * owns the journal — this moves the subledger, never the ledger — so one
 * refund never posts twice. Replays find the first entry and report it
 * without moving the balance again.
 */
export async function attachDocumentLoad(input: DocumentLoadInput): Promise<DocumentLoadResult> {
  await requireStoredValueFeature(db, input.orgId);
  if (input.amountMinor <= 0n) {
    throw storedValueRefusal({
      message: "A store-credit load must be a positive amount.",
      code: "stored_value_load_nonpositive",
      remedy: "Enter the loaded amount as a positive value.",
    });
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw storedValueRefusal({
      message: `Currency ${input.currency} is not a three-letter code.`,
      code: "stored_value_currency_invalid",
      remedy: "Load in the document currency.",
    });
  }
  const replayed = (await db.execute<{ account_id: string; id: string }>(sql`
    select account_id, id from stored_value_entries
     where org_id = ${input.orgId} and idempotency_key = ${`stored-value:load-entry:${input.idempotencyKey}`}
  `)).rows[0];
  if (replayed) {
    return { accountId: replayed.account_id, code: null, entryId: replayed.id, replayed: true };
  }
  const doc = await loadDocumentFxContext(db, input.orgId, input.documentId);
  if (input.accountId) {
    return topUpAccount(input, doc);
  }
  return mintAccount(input, doc);
}

async function topUpAccount(input: DocumentLoadInput, doc: DocumentFxContext): Promise<DocumentLoadResult> {
  const account = await lockStoredValueAccount(input.orgId, input.accountId!, input.allowedSubsidiaryIds);
  if (doc.subsidiaryId !== account.subsidiaryId) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} belongs to another legal entity than the refunding document: one entity cannot load another's balance.`,
      code: "stored_value_cross_entity",
      remedy: "Load the credit on a document of the account's own entity.",
      status: 409,
    });
  }
  if (account.status !== "active") {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} is ${account.status} and cannot be loaded.`,
      code: "stored_value_account_not_loadable",
      remedy:
        account.status === "frozen"
          ? "Unfreeze the account from the Stored value list before loading it."
          : "Issue a new code for the customer instead.",
      status: 409,
    });
  }
  if (account.currency !== input.currency) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} holds ${account.currency}, not ${input.currency}.`,
      code: "stored_value_currency_mismatch",
      remedy: `Load in ${account.currency}, or choose an account in ${input.currency}.`,
    });
  }
  // Value loaded by a refund belongs to that refund's customer; see
  // storedValueAccountOwnedByCustomer for the bearer and naming rules.
  if (!storedValueAccountOwnedByCustomer(account, input.customerPartyId ?? null)) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} belongs to another customer and cannot be loaded from this refund.`,
      code: "stored_value_customer_mismatch",
      status: 409,
      remedy:
        "Name a store credit issued to this refund's customer, or leave the account empty to issue a new one at settle.",
    });
  }
  // The refund's own journal already moved the liability at the document's
  // rate, so the top-up prices at that same rate — never at par.
  const baseCurrency = await subsidiaryBaseCurrency(db, input.orgId, account.subsidiaryId);
  const eventRate = await resolveEventRate(db, input.orgId, input.currency, baseCurrency, doc.postingDate, doc);
  const functional = functionalMinor(input.amountMinor, eventRate.units);
  const balanceMinor = account.balanceMinor + input.amountMinor;
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set balance_minor = ${balanceMinor.toString()},
           last_activity_on = CURRENT_DATE,
           updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${account.id} and balance_minor = ${account.balanceMinor.toString()}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while loading; the load was not applied.`,
      code: "stored_value_balance_changed",
      remedy: "Re-read the balance and retry.",
      status: 409,
    });
  }
  const entry = await insertStoredValueEntry(input.orgId, {
    accountId: account.id,
    kind: "adjust",
    amountMinor: input.amountMinor,
    balanceAfter: balanceMinor,
    currency: account.currency,
    functionalAmountMinor: functional,
    fxRate: eventRate.rate,
    documentId: input.documentId,
    journalEntryId: input.journalEntryId,
    idempotencyKey: `stored-value:load-entry:${input.idempotencyKey}`,
    reason: "refund to store credit",
    actorId: input.actorId ?? null,
  });
  return { accountId: account.id, code: null, entryId: entry.entryId, replayed: entry.replayed };
}

async function mintAccount(input: DocumentLoadInput, doc: DocumentFxContext): Promise<DocumentLoadResult> {
  if (!input.programId) {
    throw storedValueRefusal({
      message: "A new store credit needs its issuing program.",
      code: "stored_value_load_program_missing",
      remedy: "Choose the store credit program on the refund, then retry.",
    });
  }
  const program = await loadStoredValueProgram(input.orgId, input.programId);
  if (program.kind !== "store_credit" || !program.isActive) {
    throw storedValueRefusal({
      message: `The ${program.name} program cannot issue store credit.`,
      code: "stored_value_load_program_kind",
      remedy: "Choose an active store credit program on the refund, then retry.",
    });
  }
  if (program.currency && program.currency !== input.currency) {
    throw storedValueRefusal({
      message: `The ${program.name} program issues in ${program.currency}, not ${input.currency}.`,
      code: "stored_value_currency_mismatch",
      remedy: `Refund in ${program.currency}, or create a ${input.currency} program.`,
    });
  }
  if (!input.customerPartyId) {
    throw storedValueRefusal({
      message: "Store credit is issued to a customer, never to bearer.",
      code: "stored_value_store_credit_customer_missing",
      remedy: "Select the customer the store credit belongs to.",
    });
  }
  const liabilityAccountId = await programLiabilityAccount(input.orgId, program);
  let expiresOn: string | null = null;
  if (program.expiryMonths) {
    expiresOn = addMonthsClamped(await businessToday(input.orgId), program.expiryMonths);
    if (!isIsoCalendarDate(expiresOn)) {
      throw storedValueRefusal({
        message: "The program expiry resolved to an invalid date.",
        code: "stored_value_date_invalid",
        remedy: "Check the program expiry, then retry.",
      });
    }
  }
  // The minted account belongs to the refund's entity and prices at the
  // refund's rate, like any other document-driven issue.
  const baseCurrency = await subsidiaryBaseCurrency(db, input.orgId, doc.subsidiaryId);
  const eventRate = await resolveEventRate(db, input.orgId, input.currency, baseCurrency, doc.postingDate, doc);
  const functional = functionalMinor(input.amountMinor, eventRate.units);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateStoredValueCode();
    const codeHash = hashStoredValueCode(input.orgId, code);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into stored_value_accounts
        (org_id, program_id, kind, code_hash, code_last4, customer_party_id, currency,
         subsidiary_id,
         issued_minor, balance_minor, expires_on, source_document_id, liability_account_id,
         created_by, updated_by)
      values (${input.orgId}, ${program.id}, ${program.kind}, ${codeHash}, ${codeLast4(code)},
        ${input.customerPartyId}, ${input.currency},
        ${doc.subsidiaryId},
        ${input.amountMinor.toString()},
        ${input.amountMinor.toString()}, ${expiresOn}, ${input.documentId},
        ${liabilityAccountId}, ${input.actorId ?? null}, ${input.actorId ?? null})
      -- A generated code collision mints a new code on the next bounded retry.
      on conflict (org_id, code_hash) do nothing
      returning id
    `)).rows;
    // A code collision is expected to be vanishingly rare but possible: the
    // conflict is benign, so mint a fresh code and retry rather than fail.
    if (inserted.length !== 1 || !inserted[0]) continue;
    const entry = await insertStoredValueEntry(input.orgId, {
      accountId: inserted[0].id,
      kind: "issue",
      amountMinor: input.amountMinor,
      balanceAfter: input.amountMinor,
      currency: input.currency,
      functionalAmountMinor: functional,
      fxRate: eventRate.rate,
      documentId: input.documentId,
      journalEntryId: input.journalEntryId,
      idempotencyKey: `stored-value:load-entry:${input.idempotencyKey}`,
      reason: "refund to store credit",
      actorId: input.actorId ?? null,
    });
    return {
      accountId: inserted[0].id,
      code,
      entryId: entry.entryId,
      replayed: entry.replayed,
    };
  }
  throw storedValueRefusal({
    message: "The stored-value code could not be minted.",
    code: "stored_value_code_collision",
    remedy: "Retry the refund settlement.",
  });
}
