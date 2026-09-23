import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import {
  createTransferOrder,
  receiveTransferOrder,
  shipTransferOrder,
} from "./transfer-orders.ts";
import { InventoryError } from "./contracts.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Transfer-order transit warehouse is a legal-entity decision. The default
 * used to be the org's oldest active transit warehouse regardless of
 * entity, so a B order shipped through A's warehouse and died at posting
 * with no way to choose — and the API could not even name a warehouse.
 * Creation now validates a caller-selected warehouse for scope and
 * subsidiary, otherwise resolves deterministically among warehouses that
 * admit the order's subsidiary, and refuses by name when none is eligible.
 * Integration partition only (filename), against a scratch org.
 */

async function subsidiary(orgId: string, rootId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${rootId}, ${name}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function businessLocation(
  orgId: string,
  subsidiaryId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children, subsidiary_id)
    values (${id}, ${orgId}, ${name}, true, '{}'::jsonb, false, ${subsidiaryId})`);
  return id;
}

async function transitWarehouse(
  orgId: string,
  locationId: string,
  code: string,
  createdAt: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active, created_at)
    values (${id}, ${orgId}, ${locationId}, ${code}, 'transit', true, ${createdAt})`);
  return id;
}

async function orderTransit(orgId: string, orderId: string): Promise<string | null> {
  return (await db.execute<{ transit_stock_location_id: string | null }>(sql`
    select transit_stock_location_id from transfer_orders where org_id = ${orgId} and id = ${orderId}`)).rows[0]!
    .transit_stock_location_id;
}

async function orderCount(orgId: string): Promise<string> {
  return (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from transfer_orders where org_id = ${orgId}`)).rows[0]!.n;
}

test("a B order skips A's older transit warehouse and ships through B's", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const subB = await subsidiary(org.orgId, org.subsidiaryId, "Second Co");
    // A's transit warehouse is OLDER: the pre-fix default (oldest active)
    // picked it for every subsidiary.
    const locA = await businessLocation(org.orgId, org.subsidiaryId, "A site");
    const transitA = await transitWarehouse(org.orgId, locA, "TRANSIT-A", "2020-01-01");
    const locB = await businessLocation(org.orgId, subB, "B site");
    const transitB = await transitWarehouse(org.orgId, locB, "TRANSIT-B", "2021-01-01");
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      unitCost: "10",
      subsidiaryId: subB,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      subsidiaryId: subB,
      orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "2" }],
    });
    assert.equal(await orderTransit(org.orgId, order.id), transitB);
    assert.notEqual(await orderTransit(org.orgId, order.id), transitA);
    const shipped = await shipTransferOrder(org.orgId, actor, order.id, org.date);
    assert.equal(shipped.status, "in_transit");
    const received = await receiveTransferOrder(org.orgId, actor, order.id, org.date);
    assert.equal(received.status, "received");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("selecting another entity's transit warehouse refuses at creation", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const subB = await subsidiary(org.orgId, org.subsidiaryId, "Second Co");
    const locA = await businessLocation(org.orgId, org.subsidiaryId, "A site");
    const transitA = await transitWarehouse(org.orgId, locA, "TRANSIT-A", "2020-01-01");
    const before = await orderCount(org.orgId);
    await assert.rejects(
      createTransferOrder(org.orgId, actor, {
        fromStockLocationId: org.stockLocationId,
        toStockLocationId: org.stockLocationId2,
        transitStockLocationId: transitA,
        subsidiaryId: subB,
        orderedOn: org.date,
        lines: [{ itemId: org.items.fifo, quantity: "2" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof InventoryError);
        assert.match((error as Error).message, /restricted to another legal entity/i);
        return true;
      },
    );
    assert.equal(await orderCount(org.orgId), before, "a refused creation persists no draft");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an order with no eligible transit warehouse refuses at creation, by name", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const subB = await subsidiary(org.orgId, org.subsidiaryId, "Second Co");
    const subC = await subsidiary(org.orgId, org.subsidiaryId, "Third Co");
    const locA = await businessLocation(org.orgId, org.subsidiaryId, "A site");
    await transitWarehouse(org.orgId, locA, "TRANSIT-A", "2020-01-01");
    const locB = await businessLocation(org.orgId, subB, "B site");
    await transitWarehouse(org.orgId, locB, "TRANSIT-B", "2021-01-01");
    const before = await orderCount(org.orgId);
    // C admits neither warehouse: creation must refuse instead of storing
    // an order that can never ship.
    await assert.rejects(
      createTransferOrder(org.orgId, actor, {
        fromStockLocationId: org.stockLocationId,
        toStockLocationId: org.stockLocationId2,
        subsidiaryId: subC,
        orderedOn: org.date,
        lines: [{ itemId: org.items.fifo, quantity: "2" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof InventoryError);
        assert.match((error as Error).message, /no active transit warehouse admits this subsidiary/i);
        assert.match((error as Error).message, /select one on the order/i);
        return true;
      },
    );
    assert.equal(await orderCount(org.orgId), before, "a refused creation persists no draft");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a caller-selected warehouse that admits the subsidiary persists", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const locA = await businessLocation(org.orgId, org.subsidiaryId, "A site");
    const transitA = await transitWarehouse(org.orgId, locA, "TRANSIT-A", "2020-01-01");
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitA,
      subsidiaryId: org.subsidiaryId,
      orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "2" }],
    });
    assert.equal(await orderTransit(org.orgId, order.id), transitA);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
