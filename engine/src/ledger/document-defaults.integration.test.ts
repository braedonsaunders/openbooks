import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, seedPostingAccount, type ScratchOrg } from "../testing/fixtures.ts";
import { resolveDocumentLineDefaults, resolveTermsDueDate } from "./document-defaults.ts";
import { createDocument } from "./document-write.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Seeded {
  org: ScratchOrg;
  hstOn: string;
  zeroRated: string;
  services: string;
  officeExpense: string;
  vendorDefaultExpense: string;
  consulting: string;
  supplies: string;
  net15: string;
}

/** A customer on Net 15 taxed HST-ON, a vendor on "Due on receipt" with a
 *  default expense account, a service item coded to 4100 and zero-rated, and a
 *  supplies item with an expense account but no income account. */
async function seed(): Promise<Seeded> {
  const org = await createScratchOrg();
  return withBypass(async () => {
    const services = await seedPostingAccount(org.orgId, "4100", "Services", "income");
    const officeExpense = await seedPostingAccount(org.orgId, "6100", "Office supplies", "expense");
    const vendorDefaultExpense = await seedPostingAccount(org.orgId, "6900", "General expense", "expense");
    const [hstOn, zeroRated] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into tax_codes (id, org_id, code, name)
      values (${hstOn}, ${org.orgId}, 'HST-ON', 'Ontario HST'), (${zeroRated}, ${org.orgId}, 'ZR', 'Zero-rated')`);
    const [net15, dueOnReceipt] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into payment_terms (id, org_id, name, net_days)
      values (${net15}, ${org.orgId}, 'Net 15', 15), (${dueOnReceipt}, ${org.orgId}, 'Due on receipt', 0)`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, payment_terms_id, tax_code_id)
      values (${org.orgId}, ${org.customerId}, ${net15}, ${hstOn})`);
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, payment_terms_id, default_expense_account_id)
      values (${org.orgId}, ${org.vendorId}, ${dueOnReceipt}, ${vendorDefaultExpense})`);
    const [consulting, supplies] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into items (id, org_id, kind, name, is_active, income_account_id, tax_code_id)
      values (${consulting}, ${org.orgId}, 'service', 'Consulting', true, ${services}, ${zeroRated})`);
    await db.execute(sql`
      insert into items (id, org_id, kind, name, is_active, expense_account_id)
      values (${supplies}, ${org.orgId}, 'non_inventory', 'Supplies', true, ${officeExpense})`);
    return { org, hstOn, zeroRated, services, officeExpense, vendorDefaultExpense, consulting, supplies, net15 };
  });
}

test("sales lines take the item income account and the customer's tax code over the item's", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const lines = await withBypass(() => resolveDocumentLineDefaults(db, s.org.orgId, {
      kind: "customer_invoice", partyId: s.org.customerId, itemIds: [s.consulting, s.supplies],
    }));
    assert.deepEqual(lines, [
      { itemId: s.consulting, accountId: s.services, accountSource: "item_income", taxCodeId: s.hstOn, taxSource: "party" },
      // No income account on the item: nothing is guessed.
      { itemId: s.supplies, accountId: null, accountSource: null, taxCodeId: s.hstOn, taxSource: "party" },
    ]);

    // Without a customer the item's own tax code applies.
    const anonymous = await withBypass(() => resolveDocumentLineDefaults(db, s.org.orgId, {
      kind: "customer_invoice", partyId: null, itemIds: [s.consulting],
    }));
    assert.equal(anonymous[0]!.taxCodeId, s.zeroRated);
    assert.equal(anonymous[0]!.taxSource, "item");

    // An inactive tax code or account is never proposed.
    await withBypass(() => db.execute(sql`update tax_codes set is_active = false where id = ${s.hstOn}`));
    await withBypass(() => db.execute(sql`update accounts set is_active = false where id = ${s.services}`));
    const retired = await withBypass(() => resolveDocumentLineDefaults(db, s.org.orgId, {
      kind: "customer_invoice", partyId: s.org.customerId, itemIds: [s.consulting],
    }));
    assert.equal(retired[0]!.accountId, null);
    assert.equal(retired[0]!.taxCodeId, s.zeroRated);
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("purchase lines take the item cost account, then the vendor default, and stocked items their posting account", { skip: !DB }, async () => {
  const s = await seed();
  try {
    await withBypass(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,inventory}', 'true'::jsonb, true) where id = ${s.org.orgId}`));
    const lines = await withBypass(() => resolveDocumentLineDefaults(db, s.org.orgId, {
      kind: "vendor_bill", partyId: s.org.vendorId, itemIds: [s.supplies, s.consulting, s.org.items.fifo],
    }));
    const byItem = new Map(lines.map((line) => [line.itemId, line]));
    assert.equal(byItem.get(s.supplies)!.accountId, s.officeExpense);
    assert.equal(byItem.get(s.supplies)!.accountSource, "item_expense");
    assert.equal(byItem.get(s.consulting)!.accountId, s.vendorDefaultExpense);
    assert.equal(byItem.get(s.consulting)!.accountSource, "vendor_expense");
    // The bill debits received-not-billed for a stocked line, so that is the default shown.
    assert.equal(byItem.get(s.org.items.fifo)!.accountId, s.org.accounts.clearing);
    assert.equal(byItem.get(s.org.items.fifo)!.accountSource, "inventory_clearing");
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("payment terms set the due date: Net 15 adds fifteen days and Due on receipt is the document date", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const invoice = await withBypass(() => resolveTermsDueDate(db, s.org.orgId, {
      kind: "customer_invoice", partyId: s.org.customerId, documentDate: "2026-07-20",
    }));
    assert.deepEqual(invoice, { termsId: s.net15, termsName: "Net 15", netDays: 15, dueDate: "2026-08-04" });
    const bill = await withBypass(() => resolveTermsDueDate(db, s.org.orgId, {
      kind: "vendor_bill", partyId: s.org.vendorId, documentDate: "2026-07-20",
    }));
    assert.equal(bill?.dueDate, "2026-07-20");
    // Credits carry no terms-derived due date.
    assert.equal(await withBypass(() => resolveTermsDueDate(db, s.org.orgId, {
      kind: "customer_credit", partyId: s.org.customerId, documentDate: "2026-07-20",
    })), null);
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("creating an invoice without a due date derives it from terms; an explicit null stays empty", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const userId = await withBypass(() => createScratchUser(s.org.orgId, "Billing Clerk", "admin"));
    const create = (dueDate: string | null | undefined) => withBypass(() => createDocument({
      orgId: s.org.orgId,
      userId: String(userId),
      kind: "customer_invoice",
      key: randomUUID(),
      subsidiaryId: s.org.subsidiaryId,
      body: {
        partyId: s.org.customerId,
        documentDate: s.org.date,
        ...(dueDate === undefined ? {} : { dueDate }),
        lines: [{ accountId: s.services, amount: "100.0000" }],
      },
      requestBody: {},
    }));
    const dueOf = async (id: string) => (await withBypass(() => db.execute<{ due_date: string | null }>(sql`
      select due_date::text as due_date from documents where id = ${id} and org_id = ${s.org.orgId}`))).rows[0]?.due_date ?? null;

    const derived = await create(undefined);
    assert.equal(derived.status, "created");
    const expected = await withBypass(() => resolveTermsDueDate(db, s.org.orgId, {
      kind: "customer_invoice", partyId: s.org.customerId, documentDate: s.org.date,
    }));
    assert.equal(await dueOf(derived.id), expected!.dueDate);

    const cleared = await create(null);
    assert.equal(await dueOf(cleared.id), null);
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});
