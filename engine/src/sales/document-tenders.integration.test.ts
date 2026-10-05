import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgContext } from "../platform/db.ts";
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
      ], { allowedSubsidiaryIds: null }),
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
      ], { allowedSubsidiaryIds: null }),
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
      withBypass(() => replaceDocumentTenders(db, org.orgId, id, [], { allowedSubsidiaryIds: null })),
      (error: unknown) => error instanceof TenderRefusal && /at least one tender/.test(error.message),
    );
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, id, [
          { kind: "bank", accountId: org.accounts.bank, amount: "100" },
        ], { allowedSubsidiaryIds: null }),
      ),
      (error: unknown) => error instanceof TenderRefusal && /must be one of/.test(error.message),
    );
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, id, [{ kind: "cash", amount: "100" }], { allowedSubsidiaryIds: null }),
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
        ], { allowedSubsidiaryIds: null }),
      ),
      (error: unknown) => error instanceof TenderRefusal && /only settle cash sales/.test(error.message),
    );
    const sale = await draftCashDoc(org, "cash_sale");
    await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, sale, [
        { kind: "cash", accountId: org.accounts.bank, amount: "100" },
      ], { allowedSubsidiaryIds: null }),
    );
    await withBypassContext(() => db.execute(sql`
      update documents set status = 'approved' where org_id = ${org.orgId} and id = ${sale}`));
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, sale, [
          { kind: "cash", accountId: org.accounts.bank, amount: "100" },
        ], { allowedSubsidiaryIds: null }),
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
        orgId: org.orgId, allowedSubsidiaryIds: null, programId: program.id, amountMinor: toUnits("80"),
        currency: "CAD", debitAccountId: org.accounts.bank, postingDate: org.date,
        idempotencyKey: `writer-gift-${randomUUID()}`, actorId,
      }),
    );
    const id = await draftCashDoc(org, "cash_sale");
    await assert.rejects(
      withBypass(() =>
        replaceDocumentTenders(db, org.orgId, id, [
          { kind: "stored_value", storedValueAccountId: issued.accountId, amount: "90" },
        ], { allowedSubsidiaryIds: null }),
      ),
      (error: unknown) =>
        error instanceof TenderRefusal && /holds 80\.0000.*less than.*90\.0000/.test(error.message),
    );
    const rows = await withBypass(() =>
      replaceDocumentTenders(db, org.orgId, id, [
        { kind: "stored_value", storedValueAccountId: issued.accountId, amount: "80" },
      ], { allowedSubsidiaryIds: null }),
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
        replaceDocumentTenders(db, org.orgId, bare, [{ kind: "stored_value", amount: "10" }], { allowedSubsidiaryIds: null }),
      ),
      (error: unknown) => error instanceof TenderRefusal && /names no stored-value account/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a draft tender naming a hidden account refuses exactly like a missing one", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const liability = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "2600", "Stored value liability", "liability_current_other"),
    );
    await enableStoredValue(org.orgId, liability);
    const program = await withBypass(() =>
      createProgram({
        orgId: org.orgId, name: "Hidden gift cards", kind: "gift_card",
        liabilityAccountId: liability, actorId: null,
      }),
    );
    const secondId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`))).rows[0]!.id;
    const foreign = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, allowedSubsidiaryIds: null, subsidiaryId: secondId, programId: program.id,
        amountMinor: toUnits("80"), currency: "CAD", debitAccountId: org.accounts.bank, postingDate: org.date,
        idempotencyKey: `hidden-gift-${randomUUID()}`, actorId: null,
      }),
    );
    const rootClerk = await withBypassContext(() => createScratchUser(org.orgId, "Scoped Till", "scoped_till"));
    await withBypassContext(() => db.execute(sql`
      update app_roles set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'scoped_till'`));
    const sale = await draftCashDoc(org, "cash_sale");
    // No explicit scope: the writer resolves the actor's live grants through
    // the canonical machinery, proving the draft path end to end.
    const attempt = (accountId: string) =>
      withOrgContext(org.orgId, () =>
        replaceDocumentTenders(db, org.orgId, sale, [
          { kind: "stored_value", storedValueAccountId: accountId, amount: "10" },
        ], { actorId: rootClerk }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
    const hidden = await attempt(foreign.accountId);
    const absent = await attempt(randomUUID());
    assert.ok(hidden instanceof TenderRefusal && absent instanceof TenderRefusal);
    assert.equal((hidden as TenderRefusal).code, "stored_value_unknown");
    assert.equal((absent as TenderRefusal).code, "stored_value_unknown");
    assert.equal(hidden.message, absent.message, "hidden and missing share one neutral refusal");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a draft tender across entities is refused at save as well as posting", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const liability = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "2600", "Stored value liability", "liability_current_other"),
    );
    await enableStoredValue(org.orgId, liability);
    const program = await withBypass(() =>
      createProgram({
        orgId: org.orgId, name: "Cross-entity gift cards", kind: "gift_card",
        liabilityAccountId: liability, actorId: null,
      }),
    );
    const secondId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`))).rows[0]!.id;
    const foreign = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, allowedSubsidiaryIds: null, subsidiaryId: secondId, programId: program.id,
        amountMinor: toUnits("80"), currency: "CAD", debitAccountId: org.accounts.bank, postingDate: org.date,
        idempotencyKey: `cross-gift-${randomUUID()}`, actorId: null,
      }),
    );
    // Unrestricted clerk (no entity restriction): visibility passes, so the
    // entity agreement itself must refuse — by name, like posting does.
    const clerk = await withBypassContext(() => createScratchUser(org.orgId, "Till Clerk", "till_clerk"));
    const sale = await draftCashDoc(org, "cash_sale");
    const error = await withOrgContext(org.orgId, () =>
      replaceDocumentTenders(db, org.orgId, sale, [
        { kind: "stored_value", storedValueAccountId: foreign.accountId, amount: "10" },
      ], { actorId: clerk }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(error instanceof TenderRefusal, "expected a tender refusal");
    assert.equal((error as TenderRefusal).code, "stored_value_cross_entity");
    assert.equal((error as TenderRefusal).status, 409);
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
      ], { allowedSubsidiaryIds: null }),
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
