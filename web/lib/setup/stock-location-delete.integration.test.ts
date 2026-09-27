import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createPickList, releasePickList } from "@openbooks/engine/src/sales/fulfillment.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import { issueInventory, receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { deleteSetupRecord } from "./write.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function enableWarehouseFeatures(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"inventory":true,"warehousing":true,"fulfillment":true}'::jsonb)
     where id = ${orgId}`);
}

async function addWarehouse(org: ScratchOrg, code: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${id}, ${org.orgId}, ${org.locationId}, ${code}, 'warehouse', true)`);
  return id;
}

async function addBin(org: ScratchOrg, warehouseId: string, code: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
    values (${id}, ${org.orgId}, ${org.locationId}, ${warehouseId}, ${code}, 'bin', true)`);
  return id;
}

async function salesOrder(org: ScratchOrg, actorId: string, number: string, quantity: string, amount: string, stockLocationId = org.stockLocationId) {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                           subsidiary_id, subtotal, tax_total, total, created_by)
    values (${orderId}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId}, ${org.date}, 'CAD', 'draft',
            ${org.subsidiaryId}, '0', '0', '0', ${actorId})`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                quantity, unit, unit_price, amount, tax_amount, stock_location_id)
    values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Widget',
            ${quantity}, 'ea', '10', ${amount}, '0', ${stockLocationId})`);
  await db.execute(sql`update documents set status = 'approved', subtotal = ${amount}, total = ${amount}
                         where id = ${orderId} and org_id = ${org.orgId}`);
  return { orderId, lineId };
}

test("stock-location deletion names stock and pick blockers before cascading unused warehouse configuration", { skip: !DB }, async () => {
  // bypass: cross-org-by-design — create the scratch tenant and its initial fixture.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      await enableWarehouseFeatures(org.orgId);
      const actorId = await createScratchUser(org.orgId, "Location Admin", "admin");
      const actor = { orgId: org.orgId, id: actorId, permissions: ["admin.setup.manage"] };
      const remove = (id: string) => deleteSetupRecord(actor, "stock-locations", id);

      const stockedWarehouse = await addWarehouse(org, "DELETE-STOCK");
      await receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: stockedWarehouse, quantity: "2", unitCost: "2.00",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const rootStock = await remove(stockedWarehouse);
      assert.equal(rootStock.status, 409);
      assert.equal(rootStock.body.code, "stock_location_in_use");
      assert.match(String(rootStock.body.error), /DELETE-STOCK.*2\.0000 remains on hand at DELETE-STOCK/);
      assert.equal(rootStock.body.remedy, "transfer or issue the remaining stock first");

      const binWarehouse = await addWarehouse(org, "DELETE-BIN-WH");
      const stockedBin = await addBin(org, binWarehouse, "DELETE-BIN");
      await receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: stockedBin, quantity: "3", unitCost: "2.00",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const descendantStock = await remove(binWarehouse);
      assert.equal(descendantStock.status, 409);
      assert.equal(descendantStock.body.code, "stock_location_in_use");
      assert.match(String(descendantStock.body.error), /DELETE-BIN-WH.*3\.0000 remains on hand at DELETE-BIN/);

      const historyWarehouse = await addWarehouse(org, "DELETE-HISTORY-WH");
      const historyBin = await addBin(org, historyWarehouse, "DELETE-HISTORY-BIN");
      await receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: historyBin, quantity: "1", unitCost: "2.00",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      await issueInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: historyBin, quantity: "1",
        subsidiaryId: org.subsidiaryId, date: org.date,
      });
      const history = await remove(historyBin);
      assert.equal(history.status, 409);
      assert.equal(history.body.code, "stock_location_in_use");
      assert.match(String(history.body.error), /DELETE-HISTORY-BIN.*inventory (movement|cost) history.*preserves its audit history/);
      assert.equal(history.body.remedy, "keep the location for audit history and clear Active instead");

      const pickWarehouse = await addWarehouse(org, "DELETE-PICK-WH");
      const pickBin = await addBin(org, pickWarehouse, "DELETE-PICK-BIN");
      await receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: pickBin, quantity: "5", unitCost: "2.00",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const order = await salesOrder(org, actorId, "SO-DELETE-PICK", "2", "20", pickWarehouse);
      const pick = await db.transaction((tx) => createPickList(tx, org.orgId, actorId, {
        salesOrderId: order.orderId,
        lines: [{ salesOrderLineId: order.lineId, binId: pickBin, quantity: "2" }],
        allowedSubsidiaryIds: null,
      }));
      assert.equal((await releasePickList(org.orgId, actorId, { pickListId: pick.id, allowedSubsidiaryIds: null })).status, "approved");
      const reservation = await remove(pickBin);
      assert.equal(reservation.status, 409);
      assert.equal(reservation.body.code, "stock_location_in_use");
      assert.match(String(reservation.body.error), /DELETE-PICK-BIN.*open pick list .* reserves bin DELETE-PICK-BIN/);
      assert.equal(reservation.body.remedy, `ship or void pick list ${pick.documentNumber} first`);

      const unusedWarehouse = await addWarehouse(org, "DELETE-UNUSED");
      await db.execute(sql`
        insert into putaway_rules (org_id, warehouse_id, sequence, strategy, target_location_id)
        values (${org.orgId}, ${unusedWarehouse}, 1, 'fixed-bin', ${unusedWarehouse})`);
      assert.deepEqual(await remove(unusedWarehouse), { status: 200, body: { ok: true } });
      const cascaded = (await db.execute<{ warehouses: number; rules: number }>(sql`
        select (select count(*)::int from warehouses where org_id = ${org.orgId} and stock_location_id = ${unusedWarehouse}) as warehouses,
               (select count(*)::int from putaway_rules where org_id = ${org.orgId} and warehouse_id = ${unusedWarehouse}) as rules`)).rows[0]!;
      assert.deepEqual(cascaded, { warehouses: 0, rules: 0 });
    });
  } finally {
    // bypass: cross-org-by-design — release and remove the scratch tenant after scoped fixture work.
    await dropScratchOrg(org.orgId);
  }
});
