import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { receiveInventory } from "./movements.ts";
import { returnableBillLines } from "./vendor-credit-prefill.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const depsFor = (org: ScratchOrg) => ({
  control: {
    ar: org.accounts.ar,
    ap: org.accounts.ap,
    bank: org.accounts.bank,
  },
});

/**
 * Live-Postgres: the vendor-credit prefill behind `?doc=new&kind=vendor_credit&creditFrom=<bill>`.
 *
 * Each bill line proposes its still-unreturned receipt quantity at the
 * original unit price; fully-returned receipts drop out so the proposal can
 * never over-return on arrival.
 */

async function prefillBill(org: ScratchOrg): Promise<{ billId: string; stockedLineId: string }> {
  const billId = randomUUID();
  const stockedLineId = randomUUID();
  const serviceLineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${billId}, ${org.orgId}, 'vendor_bill',
       ${`BILL-PREFILL-${billId.slice(0, 8)}`}, ${org.vendorId}, ${org.subsidiaryId},
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', '25', '0', '25', '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom,
       tax_overridden)
    values
      (${stockedLineId}, ${org.orgId}, ${billId}, 1, ${org.items.fifo},
       ${org.accounts.clearing}, '10', '2.5', '25', '0', false, '0', '0',
       ${org.stockLocationId}, '{}'::jsonb, false),
      (${serviceLineId}, ${org.orgId}, ${billId}, 2, ${org.items.service},
       ${org.accounts.cogs}, '1', '100', '100', '0', false, '0', '0',
       null, '{}'::jsonb, false)
  `);
  return { billId, stockedLineId };
}

async function postReturn(
  org: ScratchOrg,
  input: { itemId: string; quantity: string; amount: string; sourceReceiptMovementId: string },
): Promise<void> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'vendor_credit',
       ${`VC-PREFILL-${documentId.slice(0, 8)}`}, ${org.vendorId}, ${org.subsidiaryId},
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${input.amount}, '0',
       ${input.amount}, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom,
       tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${input.itemId},
       ${org.accounts.adjustment}, ${input.quantity}, '2.5',
       ${input.amount}, '0', false, '0', '0', ${org.stockLocationId},
       ${JSON.stringify({ inventoryReturn: { sourceReceiptMovementId: input.sourceReceiptMovementId } })}::jsonb,
       false)
  `);
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(documentId, depsFor(org));
}

test(
  "bill prefill proposes unreturned receipts and drops fully-returned ones",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { billId, stockedLineId } = await prefillBill(org);
      const receipt = await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
        documentLineId: stockedLineId,
      });
      // The stocked line proposes its full unreturned receipt at the billed
      // price; the service line prefills in full with no return evidence.
      let lines = await returnableBillLines(db, org.orgId, billId);
      assert.equal(lines.length, 2);
      const stocked = lines.find((line) => line.itemId === org.items.fifo)!;
      assert.equal(stocked.receiptMovementId, receipt.movementId);
      assert.equal(toUnits(stocked.quantity), toUnits("10"));
      assert.equal(toUnits(stocked.amount!), toUnits("25"));
      assert.equal(toUnits(stocked.returned), toUnits("0"));
      const service = lines.find((line) => line.itemId === org.items.service)!;
      assert.equal(service.receiptMovementId, null);
      assert.equal(toUnits(service.quantity), toUnits("1"));
      // After a posted return of 4, the proposal nets to the remainder.
      await postReturn(org, {
        itemId: org.items.fifo,
        quantity: "4",
        amount: "10",
        sourceReceiptMovementId: receipt.movementId,
      });
      lines = await returnableBillLines(db, org.orgId, billId);
      const narrowed = lines.find((line) => line.itemId === org.items.fifo)!;
      assert.equal(narrowed.receiptMovementId, receipt.movementId);
      assert.equal(toUnits(narrowed.quantity), toUnits("6"));
      assert.equal(toUnits(narrowed.amount!), toUnits("15"));
      assert.equal(toUnits(narrowed.returned), toUnits("4"));
      // Returning the rest drops the receipt out of the proposal entirely.
      await postReturn(org, {
        itemId: org.items.fifo,
        quantity: "6",
        amount: "15",
        sourceReceiptMovementId: receipt.movementId,
      });
      lines = await returnableBillLines(db, org.orgId, billId);
      assert.ok(lines.every((line) => line.itemId !== org.items.fifo));
      assert.equal(lines.length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
