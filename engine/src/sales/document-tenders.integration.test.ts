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
import { createProgram, issueStoredValue } from "../stored-value/accounts.ts";
import {
  hasStoredValueTenders,
  readDocumentTenders,
  replaceDocumentTenders,
  TenderRefusal,
} from "./document-tenders.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function draftCashDoc(org: ScratchOrg, kind: string, total = "100.0000"): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, ${kind}, 'draft', ${`T-${id.slice(0, 8)}`}, ${org.subsidiaryId},
              ${org.date}, 'CAD', '1', ${total}, '0', ${total}, '{}'::jsonb)`),
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

test("replace writes positioned rows in document currency", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const id = await draftCashDoc(org, "cash_sale");
    const rows = await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, id, [
        { kind: "cash", accountId: org.accounts.bank, amount: "60" },
        { kind: "card", methodLabel: "Visa", accountId: org.accounts.bank, amount: "40.0000", reference: "auth-9" },
      ], {}),
    );
    assert.deepEqual(
      rows.map((row) => [row.position, row.kind, row.amountMinor, row.currency, row.reference]),
      [
        [1, "cash", 600000n, "CAD", null],
        [2, "card", 400000n, "CAD", "auth-9"],
      ],
    );
    // A second replace swaps the set instead of stacking rows.
    const again = await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, id, [
        { kind: "cash", accountId: org.accounts.bank, amount: "100.0000" },
      ], {}),
    );
    assert.equal(again.length, 1);
    assert.equal(
      (await withBypass(() => readDocumentTenders(db, org.orgId, id))).length,
      1,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("replace refuses an empty set, an unknown kind, and a missing account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const id = await draftCashDoc(org, "cash_sale");
    await assert.rejects(
      withBypass(() => replaceDocumentTenders(db, org.orgId, id, [], {})),
      (error: unknown) => error instanceof TenderRefusal && /at least one tender/.test(error.message),
    );
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, id, [
          { kind: "bank", accountId: org.accounts.bank, amount: "100" },
        ], {}),
      ),
      (error: unknown) => error instanceof TenderRefusal && /must be one of/.test(error.message),
    );
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, id, [{ kind: "cash", amount: "100" }], {}),
      ),
      (error: unknown) => error instanceof TenderRefusal && /must name a valid clearing or bank account/.test(error.message),
    );
    assert.equal((await withBypass(() => readDocumentTenders(db, org.orgId, id))).length, 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("replace refuses non-cash documents and non-draft parents", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const invoice = await draftCashDoc(org, "customer_invoice");
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, invoice, [
          { kind: "cash", accountId: org.accounts.bank, amount: "100" },
        ], {}),
      ),
      (error: unknown) => error instanceof TenderRefusal && /only settle cash sales/.test(error.message),
    );
    const sale = await draftCashDoc(org, "cash_sale");
    await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, sale, [
        { kind: "cash", accountId: org.accounts.bank, amount: "100" },
      ], {}),
    );
    await withBypassContext(() => db.execute(sql`
      update documents set status = 'approved' where org_id = ${org.orgId} and id = ${sale}`));
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, sale, [
          { kind: "cash", accountId: org.accounts.bank, amount: "100" },
        ], {}),
      ),
      (error: unknown) => error instanceof TenderRefusal && /cannot be changed/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a sale resolves its stored-value tender and refuses an overdraw by name", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Till Clerk", "admin"));
    const liability = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "2600", "Stored value liability", "liability_current_other"),
    );
    await enableStoredValue(org.orgId, liability);
    const program = await withBypass(() =>
      createProgram({
        orgId: org.orgId, name: "Till gift cards", kind: "gift_card",
        liabilityAccountId: liability, actorId,
      }),
    );
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, programId: program.id, amountMinor: toUnits("80"),
        currency: "CAD", debitAccountId: org.accounts.bank, postingDate: org.date,
        idempotencyKey: `writer-gift-${randomUUID()}`, actorId,
      }),
    );
    const id = await draftCashDoc(org, "cash_sale");
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, id, [
          { kind: "stored_value", storedValueAccountId: issued.accountId, amount: "90" },
        ], {}),
      ),
      (error: unknown) =>
        error instanceof TenderRefusal && /holds 80\.0000.*less than.*90\.0000/.test(error.message),
    );
    const rows = await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, id, [
        { kind: "stored_value", storedValueAccountId: issued.accountId, amount: "80" },
      ], {}),
    );
    assert.equal(rows[0]?.storedValueAccountId, issued.accountId);
    assert.equal(
      await withBypass(() => hasStoredValueTenders(db, org.orgId, id)),
      true,
    );
    // A sale tender without an account has nothing to redeem.
    const bare = await draftCashDoc(org, "cash_sale");
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, bare, [{ kind: "stored_value", amount: "10" }], {}),
      ),
      (error: unknown) => error instanceof TenderRefusal && /names no stored-value account/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a refund may leave the stored-value account for the settle effect", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const liability = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "2600", "Stored value liability", "liability_current_other"),
    );
    await enableStoredValue(org.orgId, liability);
    const id = await draftCashDoc(org, "cash_refund");
    const rows = await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, id, [
        { kind: "stored_value", methodLabel: "Store credit", amount: "25" },
      ], {}),
    );
    assert.equal(rows[0]?.storedValueAccountId, null);
    assert.equal(
      await withBypass(() => hasStoredValueTenders(db, org.orgId, id)),
      true,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
