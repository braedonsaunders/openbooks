import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
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
import { receiveInventory } from "@openbooks/engine/testing/inventory/movement-receive";
import { createOrderDraft, receivePurchaseOrder } from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface Seed {
  orgId: string;
  actorId: string;
  vendorId: string;
  subsidiaryId: string;
  date: string;
  fifo: string;
  asset: string;
  clearing: string;
  ap: string;
  ar: string;
  bank: string;
  location: string;
  currency: string;
}

async function seedOrg(): Promise<Seed> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
  await db.execute(sql`
    update item_inventory_profiles set unit_conversions = '{"lb": 1}'::jsonb
     where org_id = ${org.orgId} and item_id = ${org.items.fifo}
  `);
  const currency = (
    await db.execute<{ c: string }>(
      sql`select base_currency as c from orgs where id = ${org.orgId}`,
      "objects",
    )
  )[0]!.c;
  return {
    orgId: org.orgId,
    actorId,
    vendorId: org.vendorId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    fifo: org.items.fifo,
    asset: org.accounts.invAsset,
    clearing: org.accounts.clearing,
    ap: org.accounts.ap,
    ar: org.accounts.ar,
    bank: org.accounts.bank,
    location: org.stockLocationId,
    currency,
  };
}

async function seedApprovedPo(
  seed: Seed,
  quantity: string,
): Promise<{ orderId: string; lineId: string }> {
  const order = await createOrderDraft(
    seed.orgId,
    seed.actorId,
    "purchase_order",
    randomUUID(),
    null,
  );
  const lineId = randomUUID();
  const amount = `${Number(quantity) * 6}`;
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${order.id}, 1, ${seed.fifo}, ${seed.asset},
            'Grain', ${quantity}, 'lb', '6', ${amount}, '0', '0', '0', ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', party_id = ${seed.vendorId}, subsidiary_id = ${seed.subsidiaryId},
           document_date = ${seed.date}, subtotal = ${amount}, total = ${amount}
     where id = ${order.id} and org_id = ${seed.orgId}`);
  return { orderId: order.id, lineId };
}

async function onHand(seed: Seed): Promise<string> {
  return (
    await db.execute<{ q: string }>(
      sql`
    select coalesce(sum(quantity), 0)::text as q from inventory_movements
     where org_id = ${seed.orgId} and status = 'posted' and item_id = ${seed.fifo}`,
      "objects",
    )
  )[0]!.q;
}

async function receiptCount(seed: Seed): Promise<number> {
  return (
    await db.execute<{ count: number }>(
      sql`
    select count(*)::int as count from documents
     where org_id = ${seed.orgId} and kind = 'purchase_receipt'`,
      "objects",
    )
  )[0]!.count;
}

/**
 * A goods receipt against an order line whose linked bill already
 * received the stock refuses naming the bill: receiving again would
 * bring the same units a third time.
 */
test(
  "a goods receipt after a linked bill receipt refuses naming the bill",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "40");
      // Legacy shape: the bill received first (pre-refusal drain), then the
      // link was drawn — the two evidences coexist on one line.
      const bill = await seedDrawerBillFirst(seed, "40", "BILL-M51B-1");
      await stampBillLink(seed, bill.lineId, po);
      await receiveBillStock(seed, bill.lineId, "40", "240");

      const failure = await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineId, quantity: "40" }],
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(failure instanceof Error, "the receipt must refuse");
      assert.match(failure.message, /already received on vendor bill BILL-M51B-1/);
      assert.match(failure.message, /Void vendor bill BILL-M51B-1/);
      assert.equal(toUnits(await onHand(seed)), toUnits("40"), "no third receipt posts");
      assert.equal(await receiptCount(seed), 0, "the refused receipt creates no document");
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * The receipt may still bring what the linked bill did not: a partial
 * bill receipt leaves the remainder receivable, and only the excess
 * refuses.
 */
test(
  "a goods receipt may bring the remainder past a partial linked bill receipt",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "100");
      const bill = await seedDrawerBillFirst(seed, "40", "BILL-M51B-2");
      await stampBillLink(seed, bill.lineId, po);
      await receiveBillStock(seed, bill.lineId, "40", "240");

      const over = await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineId, quantity: "61" }],
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(over instanceof Error, "the excess over the bill-covered line refuses");
      assert.match(over.message, /already received on vendor bill BILL-M51B-2/);
      assert.match(over.message, /Receive at most 60/);

      await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineId, quantity: "60" }],
      });
      assert.equal(
        toUnits(await onHand(seed)),
        toUnits("100"),
        "bill forty plus receipt sixty is the ordered hundred",
      );

      const failure = await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineId, quantity: "1" }],
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(failure instanceof Error, "anything past the bill-covered line refuses");
      assert.match(failure.message, /already received on vendor bill BILL-M51B-2/);
      assert.match(failure.message, /or do not receive/);
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * Unlinked bill-direct stock names no order line, so no receipt line can
 * attribute it: the goods receipt stays permissive (the documented
 * reverse-order boundary).
 */
test("a goods receipt after an unlinked bill receipt still posts", { skip: !DB }, async () => {
  const seed = await seedOrg();
  try {
    const bill = await seedDrawerBillFirst(seed, "40", "BILL-M51B-3");
    await postDocument(bill.billId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } });
    assert.equal(toUnits(await onHand(seed)), toUnits("40"));
    const po = await seedApprovedPo(seed, "40");

    await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
      receiptDate: seed.date,
      idempotencyKey: randomUUID(),
      lines: [{ sourceLineId: po.lineId, quantity: "40" }],
    });
    assert.equal(
      toUnits(await onHand(seed)),
      toUnits("80"),
      "unlinked bill stock does not block the receipt",
    );
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});

async function seedDrawerBillFirst(
  seed: Seed,
  quantity: string,
  number: string,
): Promise<{ billId: string; lineId: string }> {
  const billId = randomUUID();
  const amount = `${Number(quantity) * 6}`;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
       status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
    values (${billId}, ${seed.orgId}, 'vendor_bill', ${number}, ${seed.vendorId},
            ${seed.date}, ${seed.date}, ${seed.currency}, 'draft', ${seed.subsidiaryId},
            ${amount}, '0', ${amount}, '{}'::jsonb, ${seed.actorId})
  `);
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
       unit, unit_price, amount, tax_amount, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${billId}, 1, ${seed.fifo}, ${seed.clearing},
            'Grain', ${quantity}, 'lb', '6', ${amount}, '0', ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
  );
  return { billId, lineId };
}

/** Draw the match link on an approved bill the way the match action would. */
async function stampBillLink(
  seed: Seed,
  billLineId: string,
  po: { orderId: string; lineId: string },
): Promise<void> {
  const billId = (
    await db.execute<{ id: string }>(
      sql`
    select document_id as id from document_lines where id = ${billLineId}`,
      "objects",
    )
  )[0]!.id;
  await db.execute(
    sql`update documents set status = 'draft' where id = ${billId} and org_id = ${seed.orgId}`,
  );
  try {
    await db.execute(sql`
      update document_lines set custom = ${JSON.stringify({
        purchaseOrderLineId: po.lineId,
        convertedFrom: { documentId: po.orderId, lineId: po.lineId, quantity: "40.0000" },
      })}::jsonb where id = ${billLineId} and org_id = ${seed.orgId}`);
  } finally {
    await db.execute(
      sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
    );
  }
}

/**
 * The bill drain's own kernel call, for legacy fall-through stock: the
 * movement truth a linked line carries when the old drain received for
 * it, journal included, the way the historic bill-receipt entries read.
 */
async function receiveBillStock(
  seed: Seed,
  billLineId: string,
  quantity: string,
  value: string,
): Promise<void> {
  await receiveInventory(seed.orgId, seed.actorId, {
    itemId: seed.fifo,
    stockLocationId: seed.location,
    quantity,
    totalValue: value,
    subsidiaryId: seed.subsidiaryId,
    offsetAccountId: seed.clearing,
    postJournal: true,
    date: seed.date,
    documentLineId: billLineId,
    idempotencyKey: `m51b-legacy-${billLineId}`,
    memo: "Inventory receipt (bill)",
  });
}
