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
import {
  convertOrder,
  createOrderDraft,
  receivePurchaseOrder,
} from "../../../web/lib/order-cycle.ts";
import { PURCHASE_RECEIPT_KIND } from "../../../web/lib/order-kinds.ts";
import { endOfMonth } from "../platform/civil-date.ts";

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
  periodId: string;
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
    periodId: org.periodId,
  };
}

async function ensureCurrentPeriod(seed: Seed): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const monthEnd = endOfMonth(today);
  if (monthStart <= seed.date && seed.date <= monthEnd) return;
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${randomUUID()}, org_id, ${Number(today.slice(0, 4))}, ${Number(today.slice(5, 7))}, ${today.slice(0, 7)},
           ${monthStart}, ${monthEnd}, false, fiscal_calendar_id
      from accounting_periods where id = ${seed.periodId}
  `);
}

/** Retouch approved-document lines the way the product does: reopen, write, restore. */
async function retouchApproved(
  seed: Seed,
  documentId: string,
  work: () => Promise<void>,
): Promise<void> {
  await db.execute(
    sql`update documents set status = 'draft' where id = ${documentId} and org_id = ${seed.orgId}`,
  );
  try {
    await work();
  } finally {
    await db.execute(
      sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${seed.orgId}`,
    );
  }
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
  opts: { subsidiaryId?: string | null; price?: string; unit?: string | null } = {},
): Promise<{ billId: string; lineId: string }> {
  const billId = randomUUID();
  const price = opts.price ?? "6";
  const amount = `${Number(quantity) * Number(price)}`;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
       status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
    values (${billId}, ${seed.orgId}, 'vendor_bill', ${"BILL-" + billId.slice(0, 8)}, ${seed.vendorId},
            ${seed.date}, ${seed.date}, ${seed.currency}, 'draft',
            ${opts.subsidiaryId === undefined ? seed.subsidiaryId : opts.subsidiaryId},
            ${amount}, '0', ${amount}, '{}'::jsonb, ${seed.actorId})
  `);
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
       unit, unit_price, amount, tax_amount, stock_location_id, custom)
    values (${lineId}, ${seed.orgId}, ${billId}, 1, ${seed.fifo}, ${seed.clearing},
            'Grain', ${quantity}, ${opts.unit === undefined ? "lb" : opts.unit}, ${price}, ${amount}, '0',
            ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
  );
  return { billId, lineId };
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

async function billReceiptMovements(seed: Seed, billId: string): Promise<number> {
  return (
    await db.execute<{ count: number }>(
      sql`
    select count(*)::int as count from inventory_movements m
      join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
     where m.org_id = ${seed.orgId} and l.document_id = ${billId} and m.kind = 'receipt'`,
      "objects",
    )
  )[0]!.count;
}

async function balanceOf(seed: Seed, accountId: string): Promise<string> {
  return (
    await db.execute<{ amount: string }>(
      sql`
    select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${seed.orgId} and l.account_id = ${accountId} and e.status = 'posted'`,
      "objects",
    )
  )[0]!.amount;
}

function control(seed: Seed) {
  return { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } };
}

/**
 * The evaluation incident end to end: a purchase order received on a goods
 * receipt, then billed on a hand-coded bill with no explicit match. The
 * bill must clear received-not-billed (Dr 2110 / Cr 2000 at the same price)
 * and bring no second inventory movement — never receive the stock again.
 */
test(
  "an unmatched bill for received stock posts through received-not-billed with no second receipt",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "100");
      await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineId, quantity: "100" }],
      });
      assert.equal(toUnits(await onHand(seed)), toUnits("100"));

      const bill = await seedDrawerBill(seed, "100");
      await postDocument(bill.billId, control(seed));

      assert.equal(
        await billReceiptMovements(seed, bill.billId),
        0,
        "the bill brings no second receipt movement",
      );
      assert.equal(toUnits(await onHand(seed)), toUnits("100"), "on hand is unchanged by the bill");
      assert.equal(
        toUnits(await balanceOf(seed, seed.clearing)),
        toUnits("0"),
        "the bill clears received-not-billed",
      );
      assert.equal(
        toUnits(await balanceOf(seed, seed.ap)),
        toUnits("-600"),
        "the bill books its payable",
      );
      assert.equal(
        toUnits(await balanceOf(seed, seed.asset)),
        toUnits("600"),
        "inventory keeps the receipt cost",
      );
      const stamp = (
        await db.execute<{ custom: { purchaseOrderLineId?: string } }>(
          sql`
      select custom from document_lines where id = ${bill.lineId} and org_id = ${seed.orgId}`,
          "objects",
        )
      )[0]!.custom;
      assert.equal(stamp.purchaseOrderLineId, po.lineId, "posting matched the line to its order");
      const billed = (
        await db.execute<{ b: string }>(
          sql`
      select quantity_billed::text as b from document_lines where id = ${po.lineId}`,
          "objects",
        )
      )[0]!.b;
      assert.equal(toUnits(billed), toUnits("100"));
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * A bill line typed with no unit is in the item's base unit, the same
 * reading the stock conversion applies, so it matches an order line in the
 * base unit instead of slipping past matching and receiving the stock again.
 */
test("a blank-unit bill line matches its order line in the base unit", { skip: !DB }, async () => {
  const seed = await seedOrg();
  try {
    await db.execute(sql`update item_inventory_profiles set base_unit = 'lb', unit_conversions = '{}'::jsonb
                          where org_id = ${seed.orgId} and item_id = ${seed.fifo}`);
    const po = await seedApprovedPo(seed, "100");
    await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
      receiptDate: seed.date,
      idempotencyKey: randomUUID(),
      lines: [{ sourceLineId: po.lineId, quantity: "100" }],
    });
    const bill = await seedDrawerBill(seed, "100", { unit: null });
    await postDocument(bill.billId, control(seed));
    assert.equal(
      await billReceiptMovements(seed, bill.billId),
      0,
      "the bill brings no second receipt movement",
    );
    assert.equal(toUnits(await onHand(seed)), toUnits("100"));
    assert.equal(
      toUnits(await balanceOf(seed, seed.clearing)),
      toUnits("0"),
      "the bill clears received-not-billed",
    );
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});

/**
 * Every receipt-creation path the product offers ends the same way: a
 * goods receipt converted from the purchase order leaves the same cover
 * as the explicit receive endpoint, so the unmatched bill that follows
 * still clears received-not-billed with no second receipt.
 */
test(
  "a converted goods receipt leaves the same cover as the receive endpoint",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      await ensureCurrentPeriod(seed);
      const po = await seedApprovedPo(seed, "40");
      await withOrg(seed.orgId, () =>
        convertOrder(seed.orgId, seed.actorId, po.orderId, PURCHASE_RECEIPT_KIND),
      );
      assert.equal(toUnits(await onHand(seed)), toUnits("40"));

      const bill = await seedDrawerBill(seed, "40");
      await postDocument(bill.billId, control(seed));

      assert.equal(
        await billReceiptMovements(seed, bill.billId),
        0,
        "the bill brings no second receipt movement",
      );
      assert.equal(toUnits(await onHand(seed)), toUnits("40"));
      assert.equal(
        toUnits(await balanceOf(seed, seed.clearing)),
        toUnits("0"),
        "the bill clears received-not-billed",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * The evaluation shape: the bill leaves its legal entity blank (the
 * hierarchy root) while the purchase order names the root explicitly.
 * Blank is the posting default for root, so the two are the same entity
 * and the bill still matches instead of receiving the stock twice.
 */
test("a bill with a blank entity matches an order that names the root", { skip: !DB }, async () => {
  const seed = await seedOrg();
  try {
    const po = await seedApprovedPo(seed, "50");
    await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
      receiptDate: seed.date,
      idempotencyKey: randomUUID(),
      lines: [{ sourceLineId: po.lineId, quantity: "50" }],
    });

    const bill = await seedDrawerBill(seed, "50", { subsidiaryId: null });
    await postDocument(bill.billId, control(seed));

    assert.equal(
      await billReceiptMovements(seed, bill.billId),
      0,
      "the entity-mismatched bill brings no second receipt",
    );
    assert.equal(toUnits(await onHand(seed)), toUnits("50"));
    assert.equal(
      toUnits(await balanceOf(seed, seed.clearing)),
      toUnits("0"),
      "the bill clears received-not-billed",
    );
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});

/**
 * Historic data can strand the received counter at zero while live
 * receipt movements still hold the stock. Cover is the greater of the two
 * evidences, so the bill still matches instead of receiving twice.
 */
test(
  "live receipt movements cover a bill even when the received counter is stranded",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "25");
      await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineId, quantity: "25" }],
      });
      await retouchApproved(seed, po.orderId, async () => {
        await db.execute(sql`
        update document_lines set quantity_fulfilled = '0'
         where id = ${po.lineId} and org_id = ${seed.orgId}`);
      });

      const bill = await seedDrawerBill(seed, "25");
      await postDocument(bill.billId, control(seed));

      assert.equal(
        await billReceiptMovements(seed, bill.billId),
        0,
        "the bill brings no second receipt movement",
      );
      assert.equal(toUnits(await onHand(seed)), toUnits("25"));
      assert.equal(
        toUnits(await balanceOf(seed, seed.clearing)),
        toUnits("0"),
        "the bill clears received-not-billed",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * A bill line linked to a purchase-order line whose cover the drain
 * cannot see refuses instead of falling through to receiving the stock
 * again: the goods were returned (or the receipt voided) after matching,
 * so bringing them in would count stock the order no longer holds.
 */
test(
  "a linked bill line with no live cover refuses instead of receiving again",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "30");
      const bill = await seedDrawerBill(seed, "30");
      await withOrg(seed.orgId, async () => {
        const { matchVendorBillLines } =
          await import("@openbooks/engine/payables/vendor-bill-matching");
        await assert.rejects(
          matchVendorBillLines({
            orgId: seed.orgId,
            billId: bill.billId,
            actorId: seed.actorId,
            matches: [{ billLineId: bill.lineId, purchaseOrderLineId: po.lineId }],
          }),
          /received and unbilled/,
        );
      });
      // Stamp the link the way a match would, without any receipt behind it.
      await retouchApproved(seed, bill.billId, async () => {
        await db.execute(sql`
        update document_lines set custom = ${JSON.stringify({
          purchaseOrderLineId: po.lineId,
          convertedFrom: { documentId: po.orderId, lineId: po.lineId, quantity: "30.0000" },
        })}::jsonb where id = ${bill.lineId} and org_id = ${seed.orgId}`);
      });
      await assert.rejects(postDocument(bill.billId, control(seed)), (error: Error) =>
        /no received cover remains/.test(error.message),
      );
      const status = (
        await db.execute<{ status: string }>(
          sql`
      select status from documents where id = ${bill.billId}`,
          "objects",
        )
      )[0]!.status;
      assert.notEqual(status, "posted", "the refused post commits nothing");
      assert.equal(toUnits(await onHand(seed)), toUnits("0"), "no stock was received");
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);
