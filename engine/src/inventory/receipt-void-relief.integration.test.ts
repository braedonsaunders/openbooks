import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import {
  DocumentVoidError,
  requestDocumentVoid,
  requestReceiptVoidWithDependents,
} from "@openbooks/engine/ledger/document-void";
import {
  correctReceiptRemainder,
  listReceiptVoidBlockers,
} from "@openbooks/engine/inventory/receipt-void-dependents";
import { getOnHand } from "@openbooks/engine/testing/inventory/position";
import {
  createOrderDraft,
  fulfillSalesOrder,
  receivePurchaseOrder,
} from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REASON = "overstated delivery on the supplier packing slip";

interface Seed {
  orgId: string;
  actorId: string;
  vendorId: string;
  customerId: string;
  subsidiaryId: string;
  date: string;
  fifo: string;
  asset: string;
  revenue: string;
  ap: string;
  ar: string;
  bank: string;
  location: string;
}

async function seedOrg(): Promise<Seed> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
  return {
    orgId: org.orgId,
    actorId,
    vendorId: org.vendorId,
    customerId: org.customerId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    fifo: org.items.fifo,
    asset: org.accounts.invAsset,
    revenue: org.accounts.revenue,
    ap: org.accounts.ap,
    ar: org.accounts.ar,
    bank: org.accounts.bank,
    location: org.stockLocationId,
  };
}

async function seedApprovedPo(
  seed: Seed,
  _number: string,
): Promise<{ orderId: string; lineId: string }> {
  const order = await createOrderDraft(
    seed.orgId,
    seed.actorId,
    "purchase_order",
    randomUUID(),
    null,
  );
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${order.id}, 1, ${seed.fifo}, ${seed.asset},
            'Widget', '10', 'ea', '2', '20', '0', '0', '0', ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', party_id = ${seed.vendorId}, subsidiary_id = ${seed.subsidiaryId},
           document_date = ${seed.date}, subtotal = '20', total = '20'
     where id = ${order.id} and org_id = ${seed.orgId}`);
  return { orderId: order.id, lineId };
}

async function receiveFull(seed: Seed, orderId: string, lineId: string): Promise<string> {
  const receipt = await receivePurchaseOrder(seed.orgId, seed.actorId, orderId, {
    receiptDate: seed.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: lineId, quantity: "10" }],
  });
  return receipt.id;
}

async function seedPostedInvoice(seed: Seed, number: string, quantity: string): Promise<string> {
  const invoiceId = randomUUID();
  const amount = `${Number(quantity) * 5}`;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total, custom,
       created_by, updated_by)
    values (${invoiceId}, ${seed.orgId}, 'customer_invoice', ${number}, ${seed.customerId},
            ${seed.subsidiaryId}, ${seed.date}, 'CAD', 'draft', ${amount}, '0', ${amount},
            '{}'::jsonb, ${seed.actorId}, ${seed.actorId})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
       unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed,
       stock_location_id, custom)
    values (${randomUUID()}, ${seed.orgId}, ${invoiceId}, 1, ${seed.fifo}, ${seed.revenue},
            'Widget', ${quantity}, 'ea', '5', ${amount}, '0', '0', '0',
            ${seed.location}, '{}'::jsonb)`);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${invoiceId} and org_id = ${seed.orgId}`);
  await postDocument(invoiceId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } });
  return invoiceId;
}

async function seedFulfillment(
  seed: Seed,
  number: string,
  quantity: string,
): Promise<{ orderId: string; fulfillmentId: string; fulfillmentNumber: string }> {
  const order = await createOrderDraft(seed.orgId, seed.actorId, "sales_order", randomUUID(), null);
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${order.id}, 1, ${seed.fifo}, ${seed.revenue},
            'Widget', ${quantity}, 'ea', '5', ${`${Number(quantity) * 5}`}, '0', '0', '0',
            ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', party_id = ${seed.customerId}, subsidiary_id = ${seed.subsidiaryId},
           document_date = ${seed.date}, subtotal = ${`${Number(quantity) * 5}`}, total = ${`${Number(quantity) * 5}`}
     where id = ${order.id} and org_id = ${seed.orgId}`);
  const fulfillment = await fulfillSalesOrder(seed.orgId, seed.actorId, order.id, {
    fulfillmentDate: seed.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: lineId, quantity }],
  });
  return {
    orderId: order.id,
    fulfillmentId: fulfillment.id,
    fulfillmentNumber: fulfillment.documentNumber,
  };
}

async function docStatus(seed: Seed, documentId: string): Promise<string> {
  return (
    await db.execute<{ status: string }>(
      sql`
    select status from documents where id = ${documentId} and org_id = ${seed.orgId}`,
      "objects",
    )
  )[0]!.status;
}

async function voidFailure(seed: Seed, receiptId: string): Promise<DocumentVoidError> {
  const failure = await requestDocumentVoid({
    documentId: receiptId,
    orgId: seed.orgId,
    actorId: seed.actorId,
    reason: REASON,
  }).then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(failure instanceof DocumentVoidError, "consumed stock blocks the void");
  return failure;
}

/**
 * A posted invoice's COGS issue is a dead end for all-or-nothing voiding —
 * but not a dead end for the operator: the refusal names the invoice with
 * its link, states the credit-return order of operations, names the
 * unconsumed remainder, and withholds the void-with-dependents offer.
 */
test(
  "invoice consumption names its document, link and order of operations without a cascade offer",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "PO-M38-R1");
      const receiptId = await receiveFull(seed, po.orderId, po.lineId);
      await seedPostedInvoice(seed, "INV-M38-1", "4");

      const failure = await voidFailure(seed, receiptId);
      assert.equal(failure.code, "receipt-stock-consumed");
      assert.match(failure.message, /downstream consumption/);
      assert.match(failure.message, /INV-M38-1/);
      assert.match(failure.message, /customer credit/);
      assert.match(failure.message, /6/);
      const details = failure.details as {
        blockers: {
          dependents: { sourceDocument: { id: string; number: string; kind: string } | null }[];
        }[];
        allowVoidWithDependents: boolean;
        remainderQuantity: string;
      };
      assert.equal(details.blockers.length, 1);
      assert.equal(details.blockers[0]!.dependents.length, 1);
      assert.equal(details.blockers[0]!.dependents[0]!.sourceDocument?.number, "INV-M38-1");
      assert.equal(details.blockers[0]!.dependents[0]!.sourceDocument?.kind, "customer_invoice");
      assert.ok(
        details.blockers[0]!.dependents[0]!.sourceDocument?.id,
        "the dialog links the source document",
      );
      assert.equal(details.allowVoidWithDependents, false);
      assert.equal(toUnits(details.remainderQuantity), toUnits("6"));

      const relief = await listReceiptVoidBlockers(db, seed.orgId, receiptId);
      assert.equal(relief.blockers.length, 1);
      assert.equal(relief.allowVoidWithDependents, false);
      assert.equal(toUnits(relief.remainderQuantity), toUnits("6"));
      assert.equal(
        await docStatus(seed, receiptId),
        "approved",
        "the refused receipt stays voidable",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * A shipment's issue reverses through its own fulfillment void, so when
 * every dependent is a voidable fulfillment the refusal offers
 * void-with-dependents — and the cascade voids the shipment and the
 * receipt together, restoring both orders' counters and removing the stock.
 */
test(
  "fulfillment consumption offers void-with-dependents and the cascade voids both documents",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "PO-M38-R2");
      const receiptId = await receiveFull(seed, po.orderId, po.lineId);
      const shipment = await seedFulfillment(seed, "SO-M38-1", "4");

      const failure = await voidFailure(seed, receiptId);
      assert.equal(failure.code, "receipt-stock-consumed");
      assert.match(failure.message, new RegExp(shipment.fulfillmentNumber));
      const details = failure.details as { allowVoidWithDependents: boolean };
      assert.equal(details.allowVoidWithDependents, true);

      const outcome = await requestReceiptVoidWithDependents({
        documentId: receiptId,
        orgId: seed.orgId,
        actorId: seed.actorId,
        reason: REASON,
      });
      assert.equal(outcome.status, "voided");
      assert.equal(await docStatus(seed, receiptId), "voided", "the receipt voids");
      assert.equal(
        await docStatus(seed, shipment.fulfillmentId),
        "voided",
        "the dependent shipment voids first",
      );
      assert.equal(
        toUnits((await getOnHand(seed.orgId, seed.fifo, seed.location)).quantity),
        toUnits("0"),
        "the received stock is removed exactly",
      );
      const counters = (
        await db.execute<{ poFulfilled: string; soFulfilled: string }>(
          sql`
      select (select quantity_fulfilled::text from document_lines where id = ${po.lineId}) as "poFulfilled",
             (select quantity_fulfilled::text from document_lines where document_id = ${shipment.orderId}) as "soFulfilled"
    `,
          "objects",
        )
      )[0]!;
      assert.equal(
        toUnits(counters.poFulfilled),
        toUnits("0"),
        "the purchase order is receivable again",
      );
      assert.equal(
        toUnits(counters.soFulfilled),
        toUnits("0"),
        "the sales order is shippable again",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * A phantom over-receipt partly consumed by a real sale corrects through a
 * native inventory adjustment with audit: the unconsumed remainder leaves at
 * carried cost, the purchase order keeps only truly received cover, and the
 * receipt itself stands as immutable evidence.
 */
test(
  "phantom remainder corrects through adjustment with audit while the receipt stands",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "PO-M38-R3");
      const receiptId = await receiveFull(seed, po.orderId, po.lineId);
      await seedPostedInvoice(seed, "INV-M38-3", "4");

      const corrected = await correctReceiptRemainder({
        orgId: seed.orgId,
        actorId: seed.actorId,
        receiptId,
        reason: REASON,
        date: seed.date,
      });
      assert.equal(
        toUnits(corrected.adjustedQuantity),
        toUnits("6"),
        "the unconsumed remainder adjusts out",
      );
      assert.equal(
        toUnits((await getOnHand(seed.orgId, seed.fifo, seed.location)).quantity),
        toUnits("0"),
        "only truly received cover stood, and it was sold",
      );
      const fulfilled = (
        await db.execute<{ q: string }>(
          sql`
      select quantity_fulfilled::text as q from document_lines where id = ${po.lineId}`,
          "objects",
        )
      )[0]!.q;
      assert.equal(toUnits(fulfilled), toUnits("4"), "the order keeps only truly received cover");
      const audits = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from audit_log
       where org_id = ${seed.orgId} and table_name = 'documents' and row_id = ${receiptId}
         and action = 'update' and changes->>'mode' = 'receipt_remainder_corrected'`,
          "objects",
        )
      )[0]!.n;
      assert.equal(audits, 1, "the correction is audited against the receipt");
      assert.equal(await docStatus(seed, receiptId), "approved", "the receipt stands as evidence");

      // The corrected receipt stands: voiding its original ten against four
      // units of truly received cover refuses at the source-line guard, so
      // the phantom correction is the end of the path, not a void prelude.
      const failure = await voidFailure(seed, receiptId);
      assert.match(failure.message, /below zero fulfilled/);
      const counters = (
        await db.execute<{ received: string; onHand: string }>(
          sql`
      select (select quantity_fulfilled::text from document_lines where id = ${po.lineId}) as received,
             (select quantity::text from (select coalesce(sum(quantity), 0) as quantity from inventory_movements
               where org_id = ${seed.orgId} and status = 'posted' and item_id = ${seed.fifo}) s) as "onHand"
    `,
          "objects",
        )
      )[0]!;
      assert.equal(toUnits(counters.received), toUnits("4"));
      assert.equal(toUnits(counters.onHand), toUnits("0"));
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);
