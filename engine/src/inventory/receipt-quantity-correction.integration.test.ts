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
import { correctReceiptQuantity } from "@openbooks/engine/inventory/receipt-void-dependents";
import { getOnHand } from "@openbooks/engine/testing/inventory/position";
import { livePurchaseOrderLineReceipts } from "@openbooks/engine/inventory/bill-matchable-lines";
import {
  createOrderDraft,
  fulfillSalesOrder,
  receivePurchaseOrder,
} from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REASON = "supplier short-shipped thirty units against the packing slip";

interface Seed {
  orgId: string;
  actorId: string;
  vendorId: string;
  customerId: string;
  subsidiaryId: string;
  date: string;
  fifo: string;
  asset: string;
  adjustment: string;
  revenue: string;
  ap: string;
  ar: string;
  bank: string;
  location: string;
}

async function seedOrg(): Promise<Seed> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
  const profile = (
    await db.execute<{ adjustment_account_id: string }>(
      sql`
    select adjustment_account_id from item_inventory_profiles
     where org_id = ${org.orgId} and item_id = ${org.items.fifo}`,
      "objects",
    )
  )[0];
  assert.ok(profile, "the seeded inventory profile must be present");
  return {
    orgId: org.orgId,
    actorId,
    vendorId: org.vendorId,
    customerId: org.customerId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    fifo: org.items.fifo,
    asset: org.accounts.invAsset,
    adjustment: profile.adjustment_account_id,
    revenue: org.accounts.revenue,
    ap: org.accounts.ap,
    ar: org.accounts.ar,
    bank: org.accounts.bank,
    location: org.stockLocationId,
  };
}

async function seedPo(seed: Seed, quantity: string): Promise<{ orderId: string; lineId: string }> {
  const order = await createOrderDraft(
    seed.orgId,
    seed.actorId,
    "purchase_order",
    randomUUID(),
    null,
  );
  const lineId = randomUUID();
  const amount = `${Number(quantity) * 2}`;
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${order.id}, 1, ${seed.fifo}, ${seed.asset},
            'Widget', ${quantity}, 'ea', '2', ${amount}, '0', '0', '0', ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', party_id = ${seed.vendorId}, subsidiary_id = ${seed.subsidiaryId},
           document_date = ${seed.date}, subtotal = ${amount}, total = ${amount}
     where id = ${order.id} and org_id = ${seed.orgId}`);
  return { orderId: order.id, lineId };
}

async function seedReceipt(
  seed: Seed,
  orderId: string,
  lineId: string,
  quantity: string,
): Promise<{ receiptId: string; lineId: string }> {
  const receipt = await receivePurchaseOrder(seed.orgId, seed.actorId, orderId, {
    receiptDate: seed.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: lineId, quantity }],
  });
  const line = (
    await db.execute<{ id: string }>(
      sql`
    select id from document_lines where document_id = ${receipt.id} and org_id = ${seed.orgId}`,
      "objects",
    )
  )[0];
  assert.ok(line, "the native receipt must retain its source line");
  return { receiptId: receipt.id, lineId: line.id };
}

async function seedFulfillment(seed: Seed, quantity: string): Promise<string> {
  const order = await createOrderDraft(seed.orgId, seed.actorId, "sales_order", randomUUID(), null);
  const lineId = randomUUID();
  const amount = `${Number(quantity) * 5}`;
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${order.id}, 1, ${seed.fifo}, ${seed.revenue},
            'Widget', ${quantity}, 'ea', '5', ${amount}, '0', '0', '0',
            ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', party_id = ${seed.customerId}, subsidiary_id = ${seed.subsidiaryId},
           document_date = ${seed.date}, subtotal = ${amount}, total = ${amount}
     where id = ${order.id} and org_id = ${seed.orgId}`);
  const fulfillment = await fulfillSalesOrder(seed.orgId, seed.actorId, order.id, {
    fulfillmentDate: seed.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: lineId, quantity }],
  });
  return fulfillment.id;
}

async function fulfilledOf(seed: Seed, poLineId: string): Promise<string> {
  return (
    await db.execute<{ f: string }>(
      sql`
    select quantity_fulfilled::text as f from document_lines where id = ${poLineId}`,
      "objects",
    )
  )[0]!.f;
}

/**
 * Only the purchase-side count was wrong and the customer keeps the
 * goods: the sale stands, and the over-received quantity leaves through
 * the native inventory adjustment at carried cost, with the order's
 * received counter restored. The receipt itself stands as immutable
 * evidence.
 */
test(
  "a consumed-by-sale receipt line corrects to its true delivered quantity",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedPo(seed, "100");
      const receipt = await seedReceipt(seed, po.orderId, po.lineId, "100");
      const fulfillmentId = await seedFulfillment(seed, "60");
      assert.equal(
        toUnits((await getOnHand(seed.orgId, seed.fifo, seed.location)).quantity),
        toUnits("40"),
      );

      const result = await correctReceiptQuantity({
        orgId: seed.orgId,
        actorId: seed.actorId,
        receiptId: receipt.receiptId,
        lines: [{ receiptLineId: receipt.lineId, correctedQuantity: "70" }],
        reason: REASON,
        date: seed.date,
      });

      assert.equal(result.receiptId, receipt.receiptId);
      assert.equal(
        toUnits(result.adjustedQuantity),
        toUnits("30"),
        "the over-received thirty units leave",
      );
      assert.equal(result.correctedLines.length, 1);
      assert.equal(toUnits(result.correctedLines[0]!.receivedQuantity), toUnits("100"));
      assert.equal(toUnits(result.correctedLines[0]!.correctedQuantity), toUnits("70"));
      assert.equal(
        toUnits((await getOnHand(seed.orgId, seed.fifo, seed.location)).quantity),
        toUnits("10"),
        "seventy delivered less sixty sold",
      );
      assert.equal(
        toUnits(await fulfilledOf(seed, po.lineId)),
        toUnits("70"),
        "the order's received counter restores",
      );
      const status = (
        await db.execute<{ status: string }>(
          sql`
      select status from documents where id = ${receipt.receiptId}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(status, "approved", "the receipt stands as immutable evidence");
      const lineQty = (
        await db.execute<{ q: string }>(
          sql`
      select quantity::text as q from document_lines where id = ${receipt.lineId}`,
          "objects",
        )
      )[0]!.q;
      assert.equal(toUnits(lineQty), toUnits("100"), "the receipt line quantity is never edited");
      const fulfillmentStatus = (
        await db.execute<{ status: string }>(
          sql`
      select status from documents where id = ${fulfillmentId}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(fulfillmentStatus, "approved", "the sale stands");
      const adjustment = (
        await db.execute<{ amount: string }>(
          sql`
      select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${seed.orgId} and l.account_id = ${seed.adjustment} and e.status = 'posted'`,
          "objects",
        )
      )[0]!.amount;
      assert.equal(
        toUnits(adjustment),
        toUnits("60"),
        "thirty units at two dollars of carried cost hit shrink",
      );
      const audit = (
        await db.execute<{ count: number }>(
          sql`
      select count(*)::int as count from audit_log
       where org_id = ${seed.orgId} and row_id = ${receipt.receiptId}
         and changes->>'mode' = 'receipt_quantity_corrected'`,
          "objects",
        )
      )[0]!.count;
      assert.equal(audit, 1, "the correction is audited against the receipt");

      const nextCorrection = await correctReceiptQuantity({
        orgId: seed.orgId,
        actorId: seed.actorId,
        receiptId: receipt.receiptId,
        lines: [{ receiptLineId: receipt.lineId, correctedQuantity: "60" }],
        reason: REASON,
        date: seed.date,
      });
      assert.equal(
        toUnits(nextCorrection.correctedLines[0]!.receivedQuantity),
        toUnits("70"),
        "the next correction starts from the effective receipt quantity",
      );
      assert.equal(
        toUnits(nextCorrection.adjustedQuantity),
        toUnits("10"),
        "only the additional ten phantom units leave",
      );
      assert.equal(
        toUnits((await getOnHand(seed.orgId, seed.fifo, seed.location)).quantity),
        toUnits("0"),
      );
      assert.equal(toUnits(await fulfilledOf(seed, po.lineId)), toUnits("60"));
      assert.equal(
        toUnits((await livePurchaseOrderLineReceipts(db, seed.orgId, po.lineId)).quantity),
        toUnits("60"),
        "bill matching sees corrected receipt cover",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * The phantom units already left through the sale: the correction cannot
 * reverse someone else's units, so it refuses naming the unconsumed
 * remainder and the vendor-credit remedy for the short delivery.
 */
test(
  "correcting below the unconsumed remainder refuses with the vendor-credit remedy",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedPo(seed, "100");
      const receipt = await seedReceipt(seed, po.orderId, po.lineId, "100");
      await seedFulfillment(seed, "90");

      await assert.rejects(
        correctReceiptQuantity({
          orgId: seed.orgId,
          actorId: seed.actorId,
          receiptId: receipt.receiptId,
          lines: [{ receiptLineId: receipt.lineId, correctedQuantity: "70" }],
          reason: REASON,
          date: seed.date,
        }),
        (error: Error) =>
          /only .* remains unconsumed/.test(error.message) &&
          /account-only vendor credit/.test(error.message),
      );
      assert.equal(
        toUnits((await getOnHand(seed.orgId, seed.fifo, seed.location)).quantity),
        toUnits("10"),
        "the refused correction moves nothing",
      );
      assert.equal(
        toUnits(await fulfilledOf(seed, po.lineId)),
        toUnits("100"),
        "the counter is untouched",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * Raising a receipt line (or naming its recorded quantity) is not a
 * correction: a shortfall is received through the purchase order.
 */
test("correcting at or above the recorded quantity refuses", { skip: !DB }, async () => {
  const seed = await seedOrg();
  try {
    const po = await seedPo(seed, "100");
    const receipt = await seedReceipt(seed, po.orderId, po.lineId, "100");

    await assert.rejects(
      correctReceiptQuantity({
        orgId: seed.orgId,
        actorId: seed.actorId,
        receiptId: receipt.receiptId,
        lines: [{ receiptLineId: receipt.lineId, correctedQuantity: "100" }],
        reason: REASON,
        date: seed.date,
      }),
      /nothing to correct/,
    );
    await assert.rejects(
      correctReceiptQuantity({
        orgId: seed.orgId,
        actorId: seed.actorId,
        receiptId: receipt.receiptId,
        lines: [{ receiptLineId: receipt.lineId, correctedQuantity: "120" }],
        reason: REASON,
        date: seed.date,
      }),
      /receive the shortfall through the purchase order/,
    );
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});

/**
 * Billed cover cannot be cut: reverse the bill before correcting a
 * receipt it already billed.
 */
test("correcting into billed cover refuses", { skip: !DB }, async () => {
  const seed = await seedOrg();
  try {
    const po = await seedPo(seed, "100");
    const receipt = await seedReceipt(seed, po.orderId, po.lineId, "100");
    const billId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
         status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
      values (${billId}, ${seed.orgId}, 'vendor_bill', 'BILL-S3-1', ${seed.vendorId},
              ${seed.date}, ${seed.date}, 'CAD', 'draft', ${seed.subsidiaryId},
              '200', '0', '200', '{}'::jsonb, ${seed.actorId})
    `);
    const billLineId = randomUUID();
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
         unit, unit_price, amount, tax_amount, stock_location_id, custom)
      values (${billLineId}, ${seed.orgId}, ${billId}, 1, ${seed.fifo}, ${seed.asset},
              'Widget', '100', 'ea', '2', '200', '0', ${seed.location}, '{}'::jsonb)
    `);
    await db.execute(
      sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
    );
    const { matchVendorBillLines } =
      await import("@openbooks/engine/payables/vendor-bill-matching");
    await matchVendorBillLines({
      orgId: seed.orgId,
      billId,
      actorId: seed.actorId,
      matches: [{ billLineId, purchaseOrderLineId: po.lineId }],
    });
    await postDocument(billId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } });

    await assert.rejects(
      correctReceiptQuantity({
        orgId: seed.orgId,
        actorId: seed.actorId,
        receiptId: receipt.receiptId,
        lines: [{ receiptLineId: receipt.lineId, correctedQuantity: "70" }],
        reason: REASON,
        date: seed.date,
      }),
      /already billed/,
    );
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});
