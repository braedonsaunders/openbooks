import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { DocumentVoidError, requestDocumentVoid } from "@openbooks/engine/ledger/document-void";
import {
  createOrderDraft,
  fulfillSalesOrder,
  receivePurchaseOrder,
} from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REASON = "bill received stock its goods receipt already brought in";

interface Seed {
  orgId: string;
  actorId: string;
  vendorId: string;
  customerId: string;
  subsidiaryId: string;
  date: string;
  fifo: string;
  asset: string;
  clearing: string;
  ap: string;
  ar: string;
  bank: string;
  revenue: string;
  location: string;
  currency: string;
}

async function seedOrg(): Promise<Seed> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "AP Clerk", "admin");
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
    customerId: org.customerId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    fifo: org.items.fifo,
    asset: org.accounts.invAsset,
    clearing: org.accounts.clearing,
    ap: org.accounts.ap,
    ar: org.accounts.ar,
    bank: org.accounts.bank,
    revenue: org.accounts.revenue,
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

async function seedDrawerBill(
  seed: Seed,
  quantity: string,
): Promise<{ billId: string; lineId: string }> {
  const billId = randomUUID();
  const amount = `${Number(quantity) * 6}`;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
       status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
    values (${billId}, ${seed.orgId}, 'vendor_bill', ${"BILL-" + billId.slice(0, 8)}, ${seed.vendorId},
            ${seed.date}, ${seed.date}, ${seed.currency}, 'draft', ${seed.subsidiaryId},
            ${amount}, '0', ${amount}, '{}'::jsonb, ${seed.actorId})
  `);
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
       unit, unit_price, amount, tax_amount, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${billId}, 1, ${seed.fifo}, ${seed.clearing},
            'Grain', ${quantity}, 'lb', '6', ${amount}, '0',
            ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
  );
  return { billId, lineId };
}

/** The double-receipt state through live documents: bill first, goods receipt after. */
async function seedDoubleReceipt(seed: Seed, quantity: string) {
  const bill = await seedDrawerBill(seed, quantity);
  await postDocument(bill.billId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } });
  const po = await seedApprovedPo(seed, quantity);
  await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
    receiptDate: seed.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: po.lineId, quantity }],
  });
  return { po, bill };
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

async function balanceOfAll(seed: Seed, accountId: string): Promise<string> {
  return (
    await db.execute<{ amount: string }>(
      sql`
    select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${seed.orgId} and l.account_id = ${accountId} and e.status in ('posted', 'reversed')`,
      "objects",
    )
  )[0]!.amount;
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
            'Widget', ${quantity}, 'lb', '5', ${amount}, '0', '0', '0',
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

/**
 * The governed correction for a bill that double-received: voiding the
 * bill reverses its inventory receipt movement and journal (not just its
 * payable), so the goods-receipt stock stands alone; re-posting the bill
 * matched to its order then clears received-not-billed. This is the
 * operator path for already-posted double receipts.
 */
test(
  "voiding a double-receipt bill reverses its stock, then a matched rebill clears",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const { po, bill } = await seedDoubleReceipt(seed, "40");
      assert.equal(
        toUnits(await onHand(seed)),
        toUnits("80"),
        "bill plus receipt count the stock twice",
      );

      const voided = await requestDocumentVoid({
        documentId: bill.billId,
        orgId: seed.orgId,
        actorId: seed.actorId,
        reason: REASON,
        reversalDate: seed.date,
      });
      assert.equal(voided.status, "voided");
      assert.equal(
        toUnits(await onHand(seed)),
        toUnits("40"),
        "only the goods-receipt stock stands",
      );
      assert.equal(
        toUnits(await balanceOfAll(seed, seed.asset)),
        toUnits("240"),
        "inventory keeps the receipt cost",
      );
      assert.equal(
        toUnits(await balanceOfAll(seed, seed.clearing)),
        toUnits("-240"),
        "received-not-billed awaits the rebill",
      );
      assert.equal(toUnits(await balanceOfAll(seed, seed.ap)), toUnits("0"), "the payable is gone");

      // The rebill matches its order and clears received-not-billed.
      const rebill = await seedDrawerBill(seed, "40");
      const { matchVendorBillLines } =
        await import("@openbooks/engine/payables/vendor-bill-matching");
      await withOrg(seed.orgId, () =>
        matchVendorBillLines({
          orgId: seed.orgId,
          billId: rebill.billId,
          actorId: seed.actorId,
          matches: [{ billLineId: rebill.lineId, purchaseOrderLineId: po.lineId }],
        }),
      );
      await postDocument(rebill.billId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } });

      assert.equal(toUnits(await onHand(seed)), toUnits("40"), "the matched rebill moves no stock");
      assert.equal(
        toUnits(await balanceOfAll(seed, seed.clearing)),
        toUnits("0"),
        "received-not-billed clears",
      );
      assert.equal(
        toUnits(await balanceOfAll(seed, seed.ap)),
        toUnits("-240"),
        "the payable returns",
      );
      assert.equal(
        toUnits(await balanceOfAll(seed, seed.asset)),
        toUnits("240"),
        "inventory keeps the receipt cost",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * The void refuses — with the consumers and their native reverse paths —
 * when the bill-received stock has since been consumed: unwinding would
 * rewrite a sale that already happened.
 */
test("voiding a double-receipt bill refuses when its stock was sold", { skip: !DB }, async () => {
  const seed = await seedOrg();
  try {
    const { bill } = await seedDoubleReceipt(seed, "40");
    await seedFulfillment(seed, "60");

    const failure = await requestDocumentVoid({
      documentId: bill.billId,
      orgId: seed.orgId,
      actorId: seed.actorId,
      reason: REASON,
      reversalDate: seed.date,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(failure instanceof DocumentVoidError, "consumed stock blocks the void");
    assert.match(failure.message, /downstream consumption/);
    assert.match(failure.message, /sales fulfillment/);
    const status = (
      await db.execute<{ status: string }>(
        sql`
      select status from documents where id = ${bill.billId}`,
        "objects",
      )
    )[0]!.status;
    assert.equal(status, "posted", "the refused void leaves the bill posted");
    assert.equal(toUnits(await onHand(seed)), toUnits("20"), "no stock moved");
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});
