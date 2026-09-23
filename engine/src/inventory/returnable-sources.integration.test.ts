import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import { returnableSources, assertReturnSourceSelectable } from "./returnable-sources.ts";
import { assertCustomerCreditInventoryReturnsPostable } from "./documents-customer-credits.ts";
import { reverseInventoryMovement } from "./reversal.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";

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
    assert.equal(offered.sources.length, 1);
    assert.equal(offered.hasMore, false);
    assert.equal(offered.sources[0]!.movementId, shipment.issueMovementId);
    assert.equal(offered.sources[0]!.quantity, "10.0000");
    assert.equal(offered.sources[0]!.returned, "0.0000");
    assert.equal(offered.sources[0]!.remaining, "10.0000");
    assert.equal(offered.sources[0]!.documentKind, "customer_invoice");

    // The same movement must not be offered to a different customer.
    const other = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${other}, ${org.orgId}, 'customer', 'Someone Else', true, '{}'::jsonb)`);
    assert.deepEqual(
      (await returnableSources(db, org.orgId, { side: "sales", partyId: other })).sources,
      [],
    );
    // Nor to the purchase leg, which consumes receipts.
    assert.deepEqual(
      (await returnableSources(db, org.orgId, { side: "purchase", partyId: org.customerId })).sources,
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
    assert.equal(offered.sources.length, 1);
    assert.equal(offered.sources[0]!.returned, "3.0000");
    assert.equal(offered.sources[0]!.remaining, "7.0000");
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
    assert.equal(offered.sources.length, 1);
    assert.equal(offered.sources[0]!.documentKind, "vendor_bill");
    assert.equal(offered.sources[0]!.remaining, "8.0000");
    // The sales leg consumes issues, so a purchase receipt never appears there.
    assert.deepEqual(
      (await returnableSources(db, org.orgId, { side: "sales", partyId: org.vendorId })).sources,
      [],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function postVendorBillLines(
  org: ScratchOrg,
  input: { subsidiaryId: string; lineCount: number; numberPrefix: string },
): Promise<string[]> {
  const billId = randomUUID();
  const lineIds = Array.from({ length: input.lineCount }, () => randomUUID());
  const unitPrice = "5";
  const total = String(input.lineCount * 5);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${billId}, ${org.orgId}, 'vendor_bill', ${`${input.numberPrefix}-${billId.slice(0, 8)}`},
       ${org.vendorId}, ${input.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
       'draft', ${total}, '0', ${total}, '{}'::jsonb)`);
  for (let i = 0; i < lineIds.length; i++) {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, is_billable,
         quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
      values
        (${lineIds[i]}, ${org.orgId}, ${billId}, ${i + 1}, ${org.items.fifo},
         ${org.accounts.invAsset}, '1', ${unitPrice}, ${unitPrice}, '0', false, '0', '0',
         ${org.stockLocationId}, '{}'::jsonb, false)`);
  }
  await db.execute(sql`
    update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
  await postDocument(billId, depsFor(org));
  return lineIds;
}

test("a return against the oldest of 201 receipts validates by exact id and pages", async () => {
  const org = await createScratchOrg();
  try {
    await postVendorBillLines(org, { subsidiaryId: org.subsidiaryId, lineCount: 201, numberPrefix: "BILL-D7" });
    const first = await returnableSources(db, org.orgId, {
      side: "purchase", partyId: org.vendorId, limit: 200,
    });
    assert.equal(first.sources.length, 200);
    assert.equal(first.hasMore, true);
    const rest = await returnableSources(db, org.orgId, {
      side: "purchase", partyId: org.vendorId, limit: 200, offset: 200,
    });
    assert.equal(rest.sources.length, 1);
    assert.equal(rest.hasMore, false);
    // The oldest source validates by exact id even though no first page
    // holds it: the old newest-200 lookup refused exactly this movement.
    const oldest = rest.sources[0]!;
    const selected = await assertReturnSourceSelectable(
      db,
      org.orgId,
      {
        side: "purchase", partyId: org.vendorId, itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, movementId: oldest.movementId,
      },
      "Line 1",
    );
    assert.equal(selected.movementId, oldest.movementId);
    assert.equal(selected.remaining, "1.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function draftCustomerCreditReturn(
  org: ScratchOrg,
  input: { issueMovementId: string; quantity: string; numberPrefix: string },
): Promise<{ creditId: string; lineId: string }> {
  const creditId = randomUUID();
  const lineId = randomUUID();
  const amount = input.quantity;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${creditId}, ${org.orgId}, 'customer_credit', ${`${input.numberPrefix}-${creditId.slice(0, 8)}`},
       ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
       'draft', ${amount}, '0', ${amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${creditId}, 1, ${org.items.fifo},
       ${org.accounts.revenue}, ${input.quantity}, '1', ${amount}, '0', false, '0', '0',
       ${org.stockLocationId},
       ${JSON.stringify({ inventoryReturn: { sourceIssueMovementId: input.issueMovementId } })}::jsonb,
       false)`);
  return { creditId, lineId };
}

async function postCustomerCreditReturn(
  org: ScratchOrg,
  input: { issueMovementId: string; quantity: string; numberPrefix: string },
): Promise<{ creditId: string; lineId: string; returnMovementId: string }> {
  const { creditId, lineId } = await draftCustomerCreditReturn(org, input);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${creditId} and org_id = ${org.orgId}`);
  await postDocument(creditId, depsFor(org));
  const receipt = (await db.execute<{ id: string }>(sql`
    select id from inventory_movements
     where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'receipt'`)).rows[0];
  assert.ok(receipt, "a posted customer credit return records a receipt movement");
  return { creditId, lineId, returnMovementId: receipt.id };
}

test("a reversed customer return is returnable again in picker, save check and post guard", async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      quantity: "5", unitCost: "4", subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const shipment = await postInvoiceShipping(org, {
      itemId: org.items.fifo, quantity: "5", unitPrice: "25", amount: "125",
    });
    const returned = await postCustomerCreditReturn(org, {
      issueMovementId: shipment.issueMovementId, quantity: "5", numberPrefix: "CM-D8",
    });
    // Fully returned: the picker offers nothing and the save check refuses.
    assert.deepEqual(
      (await returnableSources(db, org.orgId, { side: "sales", partyId: org.customerId })).sources,
      [],
    );
    await assert.rejects(
      assertReturnSourceSelectable(db, org.orgId, {
        side: "sales", partyId: org.customerId, itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, movementId: shipment.issueMovementId,
      }, "Line 1"),
      /not available to return/,
    );
    // Reverse the return itself: stock is gone again, so the remainder must
    // become selectable and returnable once more.
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await reverseInventoryMovement(org.orgId, actorId, {
      movementId: returned.returnMovementId, reversalDate: org.date, reason: "Return refused at the dock",
    });
    const offered = await returnableSources(db, org.orgId, {
      side: "sales", partyId: org.customerId,
    });
    assert.equal(offered.sources.length, 1);
    assert.equal(offered.sources[0]!.movementId, shipment.issueMovementId);
    assert.equal(offered.sources[0]!.returned, "0.0000");
    assert.equal(offered.sources[0]!.remaining, "5.0000");
    const selected = await assertReturnSourceSelectable(db, org.orgId, {
      side: "sales", partyId: org.customerId, itemId: org.items.fifo,
      stockLocationId: org.stockLocationId, movementId: shipment.issueMovementId,
    }, "Line 1");
    assert.equal(selected.remaining, "5.0000");
    // And a later DRAFT credit for the same 5 units passes the post guard:
    // the reversed return no longer counts as already returned. (The guard
    // runs pre-post, so it is checked on a draft, not on a posted credit
    // whose own receipt would count against itself.)
    const second = await draftCustomerCreditReturn(org, {
      issueMovementId: shipment.issueMovementId, quantity: "5", numberPrefix: "CM-D8B",
    });
    await assertCustomerCreditInventoryReturnsPostable(db, org.orgId, second.creditId, org.customerId, org.subsidiaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function extraSubsidiary(org: ScratchOrg, name: string): Promise<string> {
  const id = randomUUID();
  // One root per org: the scratch fixture already created it, so further
  // legal entities hang under the root.
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${name}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

test("sources scope to the full subsidiary grant; an empty grant sees nothing", async () => {
  const org = await createScratchOrg();
  try {
    const subB = await extraSubsidiary(org, "Second Co");
    const subC = await extraSubsidiary(org, "Third Co");
    // One shared vendor with receipts in A (the scratch subsidiary) and C.
    // The vendor must transact with C before a bill can post there.
    await db.execute(sql`
      insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
      values (${randomUUID()}, ${org.orgId}, ${org.vendorId}, ${subC})`);
    await postVendorBillLines(org, { subsidiaryId: org.subsidiaryId, lineCount: 1, numberPrefix: "BILL-D9A" });
    await postVendorBillLines(org, { subsidiaryId: subC, lineCount: 1, numberPrefix: "BILL-D9C" });
    const scoped = await returnableSources(db, org.orgId, {
      side: "purchase", partyId: org.vendorId, subsidiaryIds: [org.subsidiaryId, subB],
    });
    assert.equal(scoped.sources.length, 1, "a grant of {A,B} must not surface C's receipt");
    assert.match(scoped.sources[0]!.documentNumber ?? "", /BILL-D9A-/);
    assert.deepEqual(
      (await returnableSources(db, org.orgId, {
        side: "purchase", partyId: org.vendorId, subsidiaryIds: [],
      })).sources,
      [],
      "an empty grant matches nothing instead of leaking every entity",
    );
    assert.equal(
      (await returnableSources(db, org.orgId, { side: "purchase", partyId: org.vendorId })).sources.length,
      2,
      "full access still reads org-wide",
    );
    // Save-time agreement: the A receipt validates under [A] and refuses
    // under [B], naming the refusal instead of saving a foreign source.
    const movementA = scoped.sources[0]!.movementId;
    assert.ok(
      (await assertReturnSourceSelectable(db, org.orgId, {
        side: "purchase", partyId: org.vendorId, itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, movementId: movementA, subsidiaryIds: [org.subsidiaryId],
      }, "Line 1")).movementId,
    );
    await assert.rejects(
      assertReturnSourceSelectable(db, org.orgId, {
        side: "purchase", partyId: org.vendorId, itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, movementId: movementA, subsidiaryIds: [subB],
      }, "Line 1"),
      /not available to return/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
