import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "@openbooks/engine/platform/db";
import { createOrderDraft } from "./order-cycle.ts";
import { listReceivablePurchaseOrders } from "./receivable-purchase-orders.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "the receipt picker lists only open inventory and assembly lines outside drop-ship orders",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Receipt Picker", "admin"),
      );
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb)
       where id = ${org.orgId}
    `),
      );
      const stockOrderId = await seedOrder(org, actorId, [org.items.fifo, org.items.service]);
      const assemblyOrderId = await seedOrder(org, actorId, [org.items.assembly]);
      await seedOrder(org, actorId, [org.items.service]);
      const dropShipOrderId = await seedOrder(org, actorId, [org.items.fifo]);
      const salesOrder = await withOrg(org.orgId, () =>
        createOrderDraft(org.orgId, actorId, "sales_order", randomUUID(), null),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into drop_ship_orders (org_id, purchase_order_id, sales_order_id, ship_to_address)
      values (${org.orgId}, ${dropShipOrderId}, ${salesOrder.id}, '{}'::jsonb)
    `),
      );

      const result = await withOrg(org.orgId, () => listReceivablePurchaseOrders(org.orgId, null));
      const selected = new Map(result.rows.map((row) => [row.id, row.openLines]));
      assert.deepEqual([...selected.keys()].sort(), [stockOrderId, assemblyOrderId].sort());
      assert.equal(selected.get(stockOrderId), 1);
      assert.equal(selected.get(assemblyOrderId), 1);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

async function seedOrder(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  itemIds: string[],
): Promise<string> {
  const total = String(itemIds.length * 20);
  const order = await withOrg(org.orgId, () =>
    createOrderDraft(org.orgId, actorId, "purchase_order", randomUUID(), null),
  );
  await withBypassContext(async () => {
    for (const [index, itemId] of itemIds.entries()) {
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description,
           quantity, unit, unit_price, amount, quantity_fulfilled, quantity_cancelled)
        values (${org.orgId}, ${order.id}, ${index + 1}, ${itemId}, ${org.accounts.cogs},
          'Receipt picker line', '2', 'ea', '10', '20', '0', '0')
      `);
    }
    await db.execute(sql`
      update documents set status = 'approved', party_id = ${org.vendorId},
        document_date = ${org.date}, subtotal = ${total}, total = ${total}
       where id = ${order.id} and org_id = ${org.orgId}
    `);
  });
  return order.id;
}
