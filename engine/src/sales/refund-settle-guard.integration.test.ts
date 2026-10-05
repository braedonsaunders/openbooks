import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { createProgram, issueStoredValue, redeemStoredValue } from "../stored-value/accounts.ts";
import { attachDocumentLoad } from "../stored-value/document-loads.ts";
import { StoredValueError } from "../stored-value/errors.ts";
import {
  replaceDocumentTenders,
  settleCashRefundTenders,
  TenderRefusal,
} from "./document-tenders.ts";
// A refund that pays out to store credit moves real customer value: the
// settle effect may only load the refund's own customer, only once, and
// only while the refund stands posted.

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function draftCashRefund(org: ScratchOrg, partyId: string | null, total = "100.0000"): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, 'cash_refund', 'draft', ${`CR-${id.slice(0, 8)}`}, ${org.subsidiaryId},
              ${partyId}, ${org.date}, 'CAD', '1', ${total}, '0', ${total}, '{}'::jsonb)`),
  );
  return id;
}

async function enableStoredValue(orgId: string, liability: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = settings
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"storedValue": true}'::jsonb)
       where id = ${orgId}`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,storedValueLiability}', to_jsonb(${liability}::text), true)
       where id = ${orgId}`);
  });
}

async function seedJournal(org: ScratchOrg, actorId: string, documentId: string): Promise<string> {
  const entryId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into journal_entries (id, org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, source_document_id, created_by, updated_by)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${`JE-SETTLE-${entryId.slice(0, 8)}`}, ${org.date},
            ${org.periodId}, ${org.subsidiaryId}, ${documentId}, ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount)
    values (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000'),
           (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-100.0000', 'CAD', '-100.0000')`));
  return entryId;
}

async function postCashDoc(org: ScratchOrg, documentId: string, entryId: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where org_id = ${org.orgId} and id = ${documentId}`));
}

async function insertTender(
  org: ScratchOrg,
  documentId: string,
  actorId: string,
  tender: { storedValueAccountId: string | null; amount: string },
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into document_tenders
      (id, org_id, document_id, position, kind, method_label, account_id,
       stored_value_account_id, amount_minor, currency, created_by, updated_by)
    values (${id}, ${org.orgId}, ${documentId}, 1, 'stored_value', 'Store credit', null,
            ${tender.storedValueAccountId}::uuid, ${toUnits(tender.amount).toString()}, 'CAD', ${actorId}, ${actorId})`));
  return id;
}

async function tenderAccount(orgId: string, tenderId: string): Promise<string | null> {
  const rows = (await withBypassContext(() => db.execute<{ accountId: string | null }>(sql`
    select stored_value_account_id as "accountId" from document_tenders
     where org_id = ${orgId} and id = ${tenderId}`))).rows;
  return rows[0]?.accountId ?? null;
}

async function accountBalance(orgId: string, accountId: string): Promise<bigint> {
  const rows = (await withBypassContext(() => db.execute<{ balance: string }>(sql`
    select balance_minor::text as balance from stored_value_accounts
     where org_id = ${orgId} and id = ${accountId}`))).rows;
  return BigInt(rows[0]!.balance);
}

interface GuardSetup {
  org: ScratchOrg;
  actorId: string;
  creditProgramId: string;
  customerA: string;
  customerB: string;
  accountB: string;
}

async function setupGuardWorld(): Promise<GuardSetup> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Refund Clerk", "admin"));
  const liability = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "2600", "Stored value liability", "liability_current_other"),
  );
  await enableStoredValue(org.orgId, liability);
  const creditProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId, name: "House store credit", kind: "store_credit",
      liabilityAccountId: liability, actorId,
    }),
  );
  const customerA = org.customerId;
  const customerB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${customerB}, ${org.orgId}, 'customer', 'Second Customer', true, '{}'::jsonb)`));
  const issuedB = await withBypass(() =>
    issueStoredValue({
      orgId: org.orgId, allowedSubsidiaryIds: null, programId: creditProgram.id, amountMinor: toUnits("50"),
      currency: "CAD", customerPartyId: customerB, debitAccountId: org.accounts.bank,
      postingDate: org.date, idempotencyKey: `guard-seed-${randomUUID()}`, actorId,
    }),
  );
  return { org, actorId, creditProgramId: creditProgram.id, customerA, customerB, accountB: issuedB.accountId };
}

test("settle refuses a refund that is not posted", { skip: !DB }, async () => {
  const setup = await setupGuardWorld();
  const { org, actorId } = setup;
  try {
    const refundId = await draftCashRefund(org, setup.customerA);
    const entryId = await seedJournal(org, actorId, refundId);
    await withBypassContext(() => db.execute(sql`
      update documents set custom = jsonb_build_object('storeCreditProgramId', ${setup.creditProgramId}::text)
       where org_id = ${org.orgId} and id = ${refundId}`));
    await insertTender(org, refundId, actorId, { storedValueAccountId: null, amount: "25" });
    await assert.rejects(
      withBypass(() => settleCashRefundTenders(org.orgId, refundId, { journalEntryId: entryId, actorId })),
      (error: unknown) => error instanceof TenderRefusal && /posted/.test(error.message),
      "a draft refund must never mint store credit",
    );
    assert.equal(
      (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from stored_value_accounts where org_id = ${org.orgId}`)).rows[0]!.n,
      1,
      "the refused settle mints nothing: only the seeded account exists",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("settle refuses a top-up into another customer's account", { skip: !DB }, async () => {
  const setup = await setupGuardWorld();
  const { org, actorId } = setup;
  try {
    const refundId = await draftCashRefund(org, setup.customerA);
    const entryId = await seedJournal(org, actorId, refundId);
    await insertTender(org, refundId, actorId, { storedValueAccountId: setup.accountB, amount: "25" });
    await postCashDoc(org, refundId, entryId);
    const before = await accountBalance(org.orgId, setup.accountB);
    await assert.rejects(
      withBypass(() => settleCashRefundTenders(org.orgId, refundId, { journalEntryId: entryId, actorId })),
      (error: unknown) => error instanceof TenderRefusal && /same customer/.test(error.message),
      "customer A's refund must not load customer B's credit",
    );
    assert.equal(await accountBalance(org.orgId, setup.accountB), before, "the refused load moves no money");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("draft tenders refuse another customer's account before posting", { skip: !DB }, async () => {
  const setup = await setupGuardWorld();
  const { org } = setup;
  try {
    const refundId = await draftCashRefund(org, setup.customerA);
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, refundId, [
          { kind: "stored_value", storedValueAccountId: setup.accountB, amount: "25" },
        ], {}),
      ),
      (error: unknown) => error instanceof TenderRefusal && /same customer/.test(error.message),
    );
    assert.equal(
      (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_tenders where org_id = ${org.orgId} and document_id = ${refundId}`)).rows[0]!.n,
      0,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a replayed settle fills the tender row instead of minting twice", { skip: !DB }, async () => {
  const setup = await setupGuardWorld();
  const { org, actorId } = setup;
  try {
    const refundId = await draftCashRefund(org, setup.customerA);
    const entryId = await seedJournal(org, actorId, refundId);
    const tenderId = await insertTender(org, refundId, actorId, { storedValueAccountId: null, amount: "25" });
    await withBypassContext(() => db.execute(sql`
      update documents set custom = jsonb_build_object('storeCreditProgramId', ${setup.creditProgramId}::text)
       where org_id = ${org.orgId} and id = ${refundId}`));
    await postCashDoc(org, refundId, entryId);
    // A first run that minted the account and its entry but crashed before
    // recording the account back on the tender row.
    const crashed = await withBypass(() =>
      attachDocumentLoad({
        orgId: org.orgId, allowedSubsidiaryIds: null, accountId: null, programId: setup.creditProgramId,
        customerPartyId: setup.customerA, amountMinor: toUnits("25"), currency: "CAD",
        documentId: refundId, journalEntryId: entryId,
        idempotencyKey: `cash-refund-tender:${refundId}:${tenderId}`, actorId,
      }),
    );
    assert.equal(await tenderAccount(org.orgId, tenderId), null);
    const settled = await withBypass(() =>
      settleCashRefundTenders(org.orgId, refundId, { journalEntryId: entryId, actorId }),
    );
    assert.equal(settled.settled, 1);
    assert.equal(await tenderAccount(org.orgId, tenderId), crashed.accountId, "the retry records the first account");
    const accounts = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from stored_value_accounts
       where org_id = ${org.orgId} and source_document_id = ${refundId}`)).rows;
    assert.equal(accounts[0]!.n, 1, "the retry mints no second account");
    assert.equal(await accountBalance(org.orgId, crashed.accountId), toUnits("25"));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a bearer gift card still tops up from any refund", { skip: !DB }, async () => {
  const setup = await setupGuardWorld();
  const { org, actorId } = setup;
  try {
    const liability = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "2601", "Gift card liability", "liability_current_other"),
    );
    const giftProgram = await withBypass(() =>
      createProgram({
        orgId: org.orgId, name: "Bearer gift cards", kind: "gift_card",
        liabilityAccountId: liability, actorId,
      }),
    );
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, allowedSubsidiaryIds: null, programId: giftProgram.id, amountMinor: toUnits("40"),
        currency: "CAD", debitAccountId: org.accounts.bank,
        postingDate: org.date, idempotencyKey: `guard-gift-${randomUUID()}`, actorId,
      }),
    );
    const refundId = await draftCashRefund(org, setup.customerA);
    const entryId = await seedJournal(org, actorId, refundId);
    await insertTender(org, refundId, actorId, { storedValueAccountId: issued.accountId, amount: "10" });
    await postCashDoc(org, refundId, entryId);
    const settled = await withBypass(() =>
      settleCashRefundTenders(org.orgId, refundId, { journalEntryId: entryId, actorId }),
    );
    assert.equal(settled.settled, 1);
    assert.equal(await accountBalance(org.orgId, issued.accountId), toUnits("50"));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a sale cannot redeem another customer's credit at posting", { skip: !DB }, async () => {
  const setup = await setupGuardWorld();
  const { org, actorId } = setup;
  try {
    const saleId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, custom)
      values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', ${`CS-${saleId.slice(0, 8)}`}, ${org.subsidiaryId},
              ${setup.customerA}, ${org.date}, 'CAD', '1', '100.0000', '0', '100.0000', '{}'::jsonb)`));
    await assert.rejects(
      withBypass(() =>
        redeemStoredValue({
          orgId: org.orgId, allowedSubsidiaryIds: null, accountId: setup.accountB, amountMinor: toUnits("10"),
          documentId: saleId, idempotencyKey: `guard-redeem-${randomUUID()}`, actorId,
        }),
      ),
      (error: unknown) => error instanceof StoredValueError && /another customer/.test(error.message),
      "customer A's sale must not spend customer B's credit",
    );
    assert.equal(await accountBalance(org.orgId, setup.accountB), toUnits("50"), "the refused redeem moves no money");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
