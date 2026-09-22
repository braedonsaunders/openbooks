import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import { returnableSources, assertReturnSourceSelectable } from "./returnable-sources.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Live-Postgres: the one reader that decides which movements a credit memo may
 * offer as a return source. The picker and the save-time reference check both
 * read it, so a source the list never offered cannot be saved and a source it
 * offered cannot be refused for a reason the list could have shown.
 */

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function postInvoiceShipping(
  org: ScratchOrg,
  input: { itemId: string; quantity: string; unitPrice: string; amount: string },
): Promise<{ documentId: string; lineId: string; issueMovementId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'customer_invoice',
       ${`INV-RS-${documentId.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${input.amount}, '0',
       ${input.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${input.itemId},
       ${org.accounts.revenue}, ${input.quantity}, ${input.unitPrice},
       ${input.amount}, '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(documentId, depsFor(org));
  const issue = (await db.execute<{ id: string }>(sql`
    select id from inventory_movements
     where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`)).rows[0];
  assert.ok(issue);
  return { documentId, lineId, issueMovementId: issue.id };
}

test("a shipment is offered until it is fully returned", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      quantity: "10", unitCost: "4", subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const shipment = await postInvoiceShipping(org, {
      itemId: org.items.fifo, quantity: "10", unitPrice: "25", amount: "250",
    });

    const offered = await returnableSources(db, org.orgId, {
      side: "sales", partyId: org.customerId, itemId: org.items.fifo,
    });
    assert.equal(offered.length, 1);
    assert.equal(offered[0]!.movementId, shipment.issueMovementId);
    assert.equal(offered[0]!.quantity, "10.0000");
    assert.equal(offered[0]!.returned, "0.0000");
    assert.equal(offered[0]!.remaining, "10.0000");
    assert.equal(offered[0]!.documentKind, "customer_invoice");

    // The same movement must not be offered to a different customer.
    const other = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${other}, ${org.orgId}, 'customer', 'Someone Else', true, '{}'::jsonb)`);
    assert.deepEqual(
      await returnableSources(db, org.orgId, { side: "sales", partyId: other }),
      [],
    );
    // Nor to the purchase leg, which consumes receipts.
    assert.deepEqual(
      await returnableSources(db, org.orgId, { side: "purchase", partyId: org.customerId }),
      [],
    );

    // A selectable source passes the save-time reference check.
    const source = await assertReturnSourceSelectable(
      db,
      org.orgId,
      {
        side: "sales", partyId: org.customerId, itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, movementId: shipment.issueMovementId,
      },
      "Line 1",
    );
    assert.equal(source.remaining, "10.0000");

    // An unrelated movement id is refused by name, not silently accepted.
    await assert.rejects(
      () =>
        assertReturnSourceSelectable(
          db,
          org.orgId,
          {
            side: "sales", partyId: org.customerId, itemId: org.items.fifo,
            stockLocationId: org.stockLocationId, movementId: randomUUID(),
          },
          "Line 1",
        ),
      /not available to return/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a posted return reduces the shipment's remaining quantity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      quantity: "10", unitCost: "4", subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const shipment = await postInvoiceShipping(org, {
      itemId: org.items.fifo, quantity: "10", unitPrice: "25", amount: "250",
    });

    const creditId = randomUUID();
    const creditLineId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, status,
         subtotal, tax_total, total, custom)
      values
        (${creditId}, ${org.orgId}, 'customer_credit', ${`CM-RS-${creditId.slice(0, 8)}`},
         ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
         'draft', '75', '0', '75', '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, is_billable,
         quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
      values
        (${creditLineId}, ${org.orgId}, ${creditId}, 1, ${org.items.fifo},
         ${org.accounts.revenue}, '3', '25', '75', '0', false, '0', '0',
         ${org.stockLocationId},
         ${JSON.stringify({ inventoryReturn: { sourceIssueMovementId: shipment.issueMovementId } })}::jsonb,
         false)`);
    await db.execute(sql`
      update documents set status = 'approved' where id = ${creditId} and org_id = ${org.orgId}`);
    await postDocument(creditId, depsFor(org));

    const offered = await returnableSources(db, org.orgId, {
      side: "sales", partyId: org.customerId, itemId: org.items.fifo,
    });
    assert.equal(offered.length, 1);
    assert.equal(offered[0]!.returned, "3.0000");
    assert.equal(offered[0]!.remaining, "7.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a receipt is offered on the purchase leg with its vendor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const billId = randomUUID();
    const billLineId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, status,
         subtotal, tax_total, total, custom)
      values
        (${billId}, ${org.orgId}, 'vendor_bill', ${`BILL-RS-${billId.slice(0, 8)}`},
         ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
         'draft', '40', '0', '40', '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, is_billable,
         quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
      values
        (${billLineId}, ${org.orgId}, ${billId}, 1, ${org.items.fifo},
         ${org.accounts.invAsset}, '8', '5', '40', '0', false, '0', '0',
         ${org.stockLocationId}, '{}'::jsonb, false)`);
    await db.execute(sql`
      update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    await postDocument(billId, depsFor(org));

    const offered = await returnableSources(db, org.orgId, {
      side: "purchase", partyId: org.vendorId, itemId: org.items.fifo,
    });
    assert.equal(offered.length, 1);
    assert.equal(offered[0]!.documentKind, "vendor_bill");
    assert.equal(offered[0]!.remaining, "8.0000");
    // The sales leg consumes issues, so a purchase receipt never appears there.
    assert.deepEqual(
      await returnableSources(db, org.orgId, { side: "sales", partyId: org.vendorId }),
      [],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
