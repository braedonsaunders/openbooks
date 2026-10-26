import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { endOfMonth, startOfMonth } from "@openbooks/engine/platform/civil-date";

// A vendor bill converted from a purchase order's received stock. Its lines
// keep the purchase-order line provenance that posting reads, and carry the
// item's received-not-billed clearing account. Posting clears that account for
// the stock a goods receipt already brought in; it never receives the stock a
// second time.
const { db, withBypassContext, withOrg, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { toUnits } = await import("@openbooks/engine/money/money");
const {
  ConversionError,
  ITEM_MISSING_RNB_ACCOUNT,
  convertOrder,
  createOrderDraft,
  receivePurchaseOrder,
  receivePurchaseOrderRemainder,
} = await import("./order-cycle.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  userId: string;
};

async function newFixture(): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
    return { org, userId };
  });
}

async function dropFixture(orgId: string): Promise<void> {
  await withBypassContext(() => dropScratchOrg(orgId));
}

/** An approved purchase order for one stocked line of ten units at two each. */
async function approvedOrder(
  fx: Fixture,
  cancelled = "0",
): Promise<{ orderId: string; sourceLineId: string }> {
  const { org, userId } = fx;
  const order = await withOrg(org.orgId, () =>
    createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null),
  );
  const sourceLineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
         unit_price, amount, tax_amount, quantity_fulfilled, quantity_cancelled, quantity_billed, stock_location_id, custom)
      values
        (${sourceLineId}, ${org.orgId}, ${order.id}, 1, ${org.items.fifo}, ${org.accounts.invAsset},
         'Widget', '10', 'ea', '2', '20', '0', '0', ${cancelled}, '0', ${org.stockLocationId}, '{}'::jsonb)
    `);
    await db.execute(sql`
      update documents
         set status = 'approved', party_id = ${org.vendorId}, subsidiary_id = ${org.subsidiaryId},
             document_date = ${org.date}, subtotal = '20', total = '20'
       where id = ${order.id} and org_id = ${org.orgId}
    `);
  });
  return { orderId: order.id, sourceLineId };
}

async function receiveFour(fx: Fixture, orderId: string, sourceLineId: string): Promise<void> {
  const { org, userId } = fx;
  await withOrg(org.orgId, () =>
    receivePurchaseOrder(org.orgId, userId, orderId, {
      receiptDate: org.date,
      idempotencyKey: `receipt-${randomUUID()}`,
      lines: [{ sourceLineId, quantity: "4" }],
    }),
  );
}

type BillLine = { id: string; accountId: string | null; custom: Record<string, unknown> };

async function billLines(fx: Fixture, billId: string): Promise<BillLine[]> {
  const { org } = fx;
  const rows = await withOrgContext(org.orgId, () =>
    db.execute<{ id: string; account_id: string | null; custom: unknown }>(
      sql`
        select id, account_id, custom from document_lines
         where org_id = ${org.orgId} and document_id = ${billId}
         order by line_number`,
      "objects",
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    custom: (row.custom ?? {}) as Record<string, unknown>,
  }));
}

async function postBill(fx: Fixture, billId: string): Promise<void> {
  const { org } = fx;
  await withBypassContext(() =>
    db.execute(
      sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`,
    ),
  );
  await withOrgContext(org.orgId, () =>
    postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
}

async function balanceOf(fx: Fixture, accountId: string): Promise<string> {
  const { org } = fx;
  return withOrgContext(
    org.orgId,
    async () =>
      (
        await db.execute<{ amount: string }>(
          sql`
        select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${org.orgId} and l.account_id = ${accountId} and e.status = 'posted'
      `,
          "objects",
        )
      )[0]!.amount,
  );
}

test(
  "a bill converted from received stock carries the purchase-order line and the clearing account",
  { skip: !DB },
  async () => {
    const fx = await newFixture();
    try {
      const { org, userId } = fx;
      const { orderId, sourceLineId } = await approvedOrder(fx);
      await receiveFour(fx, orderId, sourceLineId);

      const bill = await withOrg(org.orgId, () =>
        convertOrder(org.orgId, userId, orderId, "vendor_bill"),
      );
      const [line] = await billLines(fx, bill.id);
      assert.ok(line, "the conversion writes the received line onto the bill");
      assert.equal(
        line.custom.purchaseOrderLineId,
        sourceLineId,
        "the bill line names its purchase-order line",
      );
      assert.equal(
        line.accountId,
        org.accounts.clearing,
        "the bill line codes to the item's received-not-billed account, not the inventory asset",
      );
      assert.equal(
        (line.custom.convertedFrom as { lineId?: string } | undefined)?.lineId,
        sourceLineId,
        "the converted cover names its source line for the void path",
      );

      await postBill(fx, bill.id);

      const receipts = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ count: number }>(
            sql`
          select count(*)::int as count from inventory_movements
           where org_id = ${org.orgId} and document_line_id = ${line.id} and kind = 'receipt'`,
            "objects",
          ),
        )
      )[0]!.count;
      assert.equal(receipts, 0, "posting the bill must not receive the stock again");
      const onHand = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ quantity: string }>(
            sql`
          select coalesce(sum(quantity), 0)::text as quantity from inventory_movements
           where org_id = ${org.orgId} and item_id = ${org.items.fifo} and status = 'posted'`,
            "objects",
          ),
        )
      )[0]!.quantity;
      assert.equal(toUnits(onHand), toUnits("4"), "stock stays at the four received units");
      assert.equal(
        toUnits(await balanceOf(fx, org.accounts.clearing)),
        toUnits("0"),
        "the bill clears received-not-billed",
      );
      assert.equal(
        toUnits(await balanceOf(fx, org.accounts.ap)),
        toUnits("-8"),
        "payables carry the received value",
      );
    } finally {
      await dropFixture(fx.org.orgId);
    }
  },
);

test(
  "converting received stock refuses when its item has no received-not-billed account",
  { skip: !DB },
  async () => {
    const fx = await newFixture();
    try {
      const { org, userId } = fx;
      const { orderId, sourceLineId } = await approvedOrder(fx);
      await receiveFour(fx, orderId, sourceLineId);
      await withBypassContext(() =>
        db.execute(sql`
        update item_inventory_profiles set received_not_billed_account_id = null
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}`),
      );

      await assert.rejects(
        withOrg(org.orgId, () => convertOrder(org.orgId, userId, orderId, "vendor_bill")),
        (error: unknown) =>
          error instanceof ConversionError &&
          error.status === 422 &&
          error.code === ITEM_MISSING_RNB_ACCOUNT &&
          /received-not-billed/.test(error.message),
      );
      const bills = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ count: number }>(
            sql`
          select count(*)::int as count from documents
           where org_id = ${org.orgId} and kind = 'vendor_bill'`,
            "objects",
          ),
        )
      )[0]!.count;
      assert.equal(bills, 0, "a refused conversion writes no bill");
    } finally {
      await dropFixture(fx.org.orgId);
    }
  },
);

test(
  "receiving subtracts cancelled quantity and accumulates same-line lot requests",
  { skip: !DB },
  async () => {
    const fx = await newFixture();
    try {
      const { org, userId } = fx;
      const { orderId, sourceLineId } = await approvedOrder(fx, "6");
      const lotIds = [randomUUID(), randomUUID()];
      await withBypassContext(async () => {
        await db.execute(sql`
        update item_inventory_profiles set tracking = 'lot'
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}
      `);
        for (const [index, lotId] of lotIds.entries()) {
          await db.execute(sql`
          insert into lots (id, org_id, item_id, lot_number)
          values (${lotId}, ${org.orgId}, ${org.items.fifo}, ${`RCV-${index}-${randomUUID()}`})
        `);
        }
      });

      await assert.rejects(
        withOrg(org.orgId, () =>
          receivePurchaseOrder(org.orgId, userId, orderId, {
            receiptDate: org.date,
            idempotencyKey: `receipt-${randomUUID()}`,
            lines: [
              { sourceLineId, quantity: "4", lotId: lotIds[0] },
              { sourceLineId, quantity: "2", lotId: lotIds[1] },
            ],
          }),
        ),
        (error: unknown) =>
          error instanceof ConversionError && /only 4\.0000 remaining/.test(error.message),
      );
      await assert.rejects(
        withOrg(org.orgId, () =>
          receivePurchaseOrder(org.orgId, userId, orderId, {
            receiptDate: org.date,
            idempotencyKey: `receipt-${randomUUID()}`,
            lines: [{ sourceLineId, quantity: "5", lotId: lotIds[0] }],
          }),
        ),
        (error: unknown) =>
          error instanceof ConversionError && /only 4\.0000 remaining/.test(error.message),
      );
      const facts = await withOrgContext(org.orgId, () =>
        db.execute<{ received: string; receipts: number }>(
          sql`
      select (select quantity_fulfilled::text from document_lines where id = ${sourceLineId}) as received,
             (select count(*)::int from documents where org_id = ${org.orgId} and kind = 'purchase_receipt') as receipts
    `,
          "objects",
        ),
      );
      assert.equal(toUnits(facts[0]!.received), toUnits("0"));
      assert.equal(
        facts[0]!.receipts,
        0,
        "both refused quantities leave the order and inventory untouched",
      );
    } finally {
      await dropFixture(fx.org.orgId);
    }
  },
);

test(
  "receiving the purchase-order remainder excludes cancelled quantity",
  { skip: !DB },
  async () => {
    const fx = await newFixture();
    try {
      const { org, userId } = fx;
      const { orderId, sourceLineId } = await approvedOrder(fx, "6");
      const receiptDate = await businessToday(org.orgId);
      const openPeriod = await db.execute<{ id: string }>(
        sql`
      select id from accounting_periods
       where org_id = ${org.orgId} and starts_on <= ${receiptDate} and ends_on >= ${receiptDate}
       limit 1
    `,
        "objects",
      );
      if (!openPeriod[0]) {
        const calendarId = (
          await db.execute<{ fiscal_calendar_id: string }>(
            sql`
        select fiscal_calendar_id from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}
      `,
            "objects",
          )
        )[0]!.fiscal_calendar_id;
        const periodNumber = Number(receiptDate.slice(5, 7));
        await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, ${Number(receiptDate.slice(0, 4))}, ${periodNumber},
                ${receiptDate.slice(0, 7)}, ${startOfMonth(receiptDate)}, ${endOfMonth(receiptDate)}, false, ${calendarId})
      `);
      }
      await withOrg(org.orgId, () => receivePurchaseOrderRemainder(org.orgId, userId, orderId));
      const facts = await withOrgContext(org.orgId, () =>
        db.execute<{ received: string; moved: string }>(
          sql`
      select (select quantity_fulfilled::text from document_lines where id = ${sourceLineId}) as received,
             (select coalesce(sum(quantity), 0)::text from inventory_movements
               where org_id = ${org.orgId} and item_id = ${org.items.fifo} and status = 'posted') as moved
    `,
          "objects",
        ),
      );
      assert.equal(toUnits(facts[0]!.received), toUnits("4"));
      assert.equal(toUnits(facts[0]!.moved), toUnits("4"));
    } finally {
      await dropFixture(fx.org.orgId);
    }
  },
);
