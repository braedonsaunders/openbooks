import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { creditItemsForParty } from "./payment-queries.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Live-Postgres: creditItemsForParty lists posted, still-open credit-memo
// lines (the application sources a receipt needs) for a party. The open-items
// reader only returns debit items a payment can extinguish, so without this
// reader a posted credit memo is invisible to every receipt flow.

async function draftAndPostCredit(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  documentNumber: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${org.orgId}, 'customer_credit', 'draft', ${documentNumber},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '210', '0', '210', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue},
              '1', '210', '210', '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${id} and org_id = ${org.orgId}`);
  });
  await withBypass(() =>
    postDocument(id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  return id;
}

test("creditItemsForParty is empty before the credit posts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const found = await withBypass(() => creditItemsForParty(org.customerId, "ar", org.orgId));
    assert.deepEqual(found, []);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("creditItemsForParty lists the posted credit line with its open balance", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Credit reader", "admin"));
    const id = await draftAndPostCredit(org, userId, "CM-READ-1");
    const found = await withBypass(() => creditItemsForParty(org.customerId, "ar", org.orgId));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.documentId, id);
    assert.equal(found[0]!.documentNumber, "CM-READ-1");
    assert.equal(found[0]!.documentKind, "customer_credit");
    assert.equal(found[0]!.amount, "210.0000");
    assert.equal(found[0]!.open, "210.0000");
    assert.equal(found[0]!.currency, "CAD");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
