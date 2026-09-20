import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { PostingError, postDocument } from "../ledger/posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Live-Postgres regression: document lines carry an item's profile through an
// INNER join, so an inventory-kind item with no costing profile is silently
// skipped by the legacy bill-receipt and standalone-invoice paths — the bill
// posts as pure expense with no stock, the invoice posts revenue with no
// COGS. The governed paths (purchase-order receipt, sales fulfillment)
// refuse such lines outright. Posting must refuse them the same way.

async function seedUnprofiledInventoryItem(orgId: string): Promise<string> {
  const itemId = randomUUID();
  const accounts = await db.execute<{ revenue: string; cogs: string }>(sql`
    select (select id from accounts where org_id = ${orgId} order by number limit 1) as revenue,
           (select id from accounts where org_id = ${orgId} order by number limit 1) as cogs`);
  await db.execute(sql`
    insert into items (id, org_id, kind, code, name, income_account_id, expense_account_id, is_active, custom)
    values (${itemId}, ${orgId}, 'inventory', ${`NOPROFILE-${itemId.slice(0, 8)}`}, 'Unprofiled widget',
            ${accounts.rows[0]!.revenue}, ${accounts.rows[0]!.cogs}, true, '{}'::jsonb)`);
  const profile = await db.execute(sql`
    select 1 from item_inventory_profiles where org_id = ${orgId} and item_id = ${itemId}`);
  assert.equal(profile.rows.length, 0, "the fixture item must have no costing profile");
  return itemId;
}

const depsFor = (org: Awaited<ReturnType<typeof createScratchOrg>>) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

test("a vendor bill for an inventory item without a costing profile cannot post", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const itemId = await withBypass(() => seedUnprofiledInventoryItem(org.orgId));
    const documentId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values
          (${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-NOPROFILE', ${org.vendorId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', 1, 'draft', '20', '0', '20', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           quantity, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
        values
          (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${itemId},
           ${org.accounts.cogs}, '10', '2', '20', '0', false,
           '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
      await db.execute(sql`
        update documents set status = 'approved'
         where id = ${documentId} and org_id = ${org.orgId}`);
    });
    await assert.rejects(
      postDocument(documentId, depsFor(org)),
      (error: unknown) =>
        error instanceof PostingError && /costing profile/.test(error.message),
    );
    const untouched = await db.execute<{ status: string; entries: number; receipts: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${documentId}) as entries,
             (select count(*)::int from inventory_movements movement
               join document_lines line on line.id = movement.document_line_id
              where movement.org_id = ${org.orgId} and line.document_id = ${documentId}
                and movement.kind = 'receipt') as receipts
        from documents where id = ${documentId} and org_id = ${org.orgId}`);
    assert.deepEqual(untouched.rows[0], { status: "approved", entries: 0, receipts: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a standalone invoice for an inventory item without a costing profile cannot post", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const itemId = await withBypass(() => seedUnprofiledInventoryItem(org.orgId));
    const documentId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values
          (${documentId}, ${org.orgId}, 'customer_invoice', 'INV-NOPROFILE', ${org.customerId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', 1, 'draft', '20', '0', '20', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           quantity, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
        values
          (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${itemId},
           ${org.accounts.revenue}, '10', '2', '20', '0', true,
           '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
      await db.execute(sql`
        update documents set status = 'approved'
         where id = ${documentId} and org_id = ${org.orgId}`);
    });
    await assert.rejects(
      postDocument(documentId, depsFor(org)),
      (error: unknown) =>
        error instanceof PostingError && /costing profile/.test(error.message),
    );
    const untouched = await db.execute<{ status: string; entries: number; issues: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${documentId}) as entries,
             (select count(*)::int from inventory_movements movement
               join document_lines line on line.id = movement.document_line_id
              where movement.org_id = ${org.orgId} and line.document_id = ${documentId}
                and movement.kind = 'issue') as issues
        from documents where id = ${documentId} and org_id = ${org.orgId}`);
    assert.deepEqual(untouched.rows[0], { status: "approved", entries: 0, issues: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

// F-t07-003: INV-00001 posted $89 of revenue with no COGS because its line
// carried no stock_location_id while the org had two active locations.
// loadDocumentInventoryLines threw inside the post-commit effects drain, so
// the journal committed and the posting_effects row sat at failed —
// silently. Posting must refuse the invoice before the entry is written,
// naming the line, the way the vendor-bill leg already does.
test("a standalone invoice for a profiled inventory item without a resolvable stock location cannot post", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const documentId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values
          (${documentId}, ${org.orgId}, 'customer_invoice', 'INV-NOLOC', ${org.customerId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', 1, 'draft', '20', '0', '20', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           quantity, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
        values
          (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${org.items.movingAvg},
           ${org.accounts.revenue}, '10', '2', '20', '0', true,
           '0', '0', null, '{}'::jsonb, false)`);
      await db.execute(sql`
        update documents set status = 'approved'
         where id = ${documentId} and org_id = ${org.orgId}`);
    });
    await assert.rejects(
      postDocument(documentId, depsFor(org)),
      (error: unknown) =>
        error instanceof PostingError && /stock location/.test(error.message),
    );
    const untouched = await db.execute<{ status: string; entries: number; issues: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${documentId}) as entries,
             (select count(*)::int from inventory_movements movement
               join document_lines line on line.id = movement.document_line_id
              where movement.org_id = ${org.orgId} and line.document_id = ${documentId}
                and movement.kind = 'issue') as issues
        from documents where id = ${documentId} and org_id = ${org.orgId}`);
    assert.deepEqual(untouched.rows[0], { status: "approved", entries: 0, issues: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

// The fulfilment-governed path owns stock at shipment time, so an invoice
// converted from a sales order must keep posting even though its own lines
// carry no location for the issue hook to use.
test("an invoice governed by sales fulfillment posts without a line stock location", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Billing Clerk", "admin"));
    const orderId = randomUUID();
    const documentId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values
          (${orderId}, ${org.orgId}, 'sales_order', 'SO-GOVERNED', ${org.customerId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', 1, 'approved', '20', '0', '20', '{}'::jsonb)`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values
          (${documentId}, ${org.orgId}, 'customer_invoice', 'INV-GOVERNED', ${org.customerId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', 1, 'draft', '20', '0', '20', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           quantity, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
        values
          (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${org.items.movingAvg},
           ${org.accounts.revenue}, '10', '2', '20', '0', true,
           '0', '0', null, '{}'::jsonb, false)`);
      await db.execute(sql`
        insert into document_links (id, org_id, from_document_id, to_document_id, link_type, created_by)
        values (${randomUUID()}, ${org.orgId}, ${orderId}, ${documentId}, 'bills', ${userId})`);
      await db.execute(sql`
        update documents set status = 'approved'
         where id = ${documentId} and org_id = ${org.orgId}`);
    });
    await postDocument(documentId, depsFor(org));
    const posted = await db.execute<{ status: string; entries: number; issues: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${documentId}) as entries,
             (select count(*)::int from inventory_movements movement
               join document_lines line on line.id = movement.document_line_id
              where movement.org_id = ${org.orgId} and line.document_id = ${documentId}
                and movement.kind = 'issue') as issues
        from documents where id = ${documentId} and org_id = ${org.orgId}`);
    assert.deepEqual(posted.rows[0], { status: "posted", entries: 1, issues: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
