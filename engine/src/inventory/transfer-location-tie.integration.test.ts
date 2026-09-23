import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import {
  createTransferOrder,
  receiveTransferOrder,
  shipTransferOrder,
} from "./transfer-orders.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A transfer order's ship/receive legs used to post the location-dimension
 * reclass inside transferInventoryTx AND the in-transit reclass on top, so
 * every location balance doubled while the aggregate still netted to zero.
 * This pins the per-location GL-to-subledger tie across three locations at
 * both ends of the shipment: each business location's posted inventory GL
 * must equal its layers' carrying value, with the in-transit account holding
 * exactly the transit location's value mid-flight.
 */
test("transfer-order in-transit legs post each location balance exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;

    // A third business location behind the transit warehouse, so all three
    // legs carry distinct location dimensions.
    const transitDim = randomUUID();
    await db.execute(sql`
      insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
      values (${transitDim}, ${org.orgId}, 'GATEWAY', true, '{}'::jsonb, true)`);
    const transitId = randomUUID();
    await db.execute(sql`
      insert into stock_locations (id, org_id, location_id, code, kind, is_active)
      values (${transitId}, ${org.orgId}, ${transitDim}, 'GATEWAY-T', 'transit', true)`);
    const inTransit = randomUUID();
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values
        (${inTransit}, ${org.orgId}, '1390', 'Goods in transit',
         'asset_current_other', false, true, false, false, '[]'::jsonb,
         '{}'::jsonb, true)`);

    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "10",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitId,
      inTransitAccountId: inTransit,
      subsidiaryId: org.subsidiaryId,
      orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "10" }],
    });

    const dims = async (): Promise<Map<string, string>> => {
      const rows = (await db.execute<{ stock: string; dim: string }>(sql`
        select id as stock, location_id as dim from stock_locations
         where org_id = ${org.orgId}
           and id in (${org.stockLocationId}, ${transitId}, ${org.stockLocationId2})`)).rows;
      return new Map(rows.map((row) => [row.stock, row.dim]));
    };
    const glByDim = async (accountId: string): Promise<Map<string, string>> => {
      const rows = (await db.execute<{ dim: string | null; balance: string }>(sql`
        select l.location_id as dim, sum(l.amount)::text as balance
          from journal_lines l
         where l.org_id = ${org.orgId} and l.account_id = ${accountId}
         group by l.location_id`)).rows;
      return new Map(rows.map((row) => [row.dim ?? "", row.balance]));
    };
    const tie = async (label: string) => {
      const dim = await dims();
      const asset = await glByDim(org.accounts.invAsset);
      const transit = await glByDim(inTransit);
      for (const stock of [org.stockLocationId, transitId, org.stockLocationId2] as const) {
        const layers = (await getOnHand(org.orgId, org.items.fifo, stock)).value;
        const locationDim = dim.get(stock)!;
        if (stock === transitId) {
          // Mid-flight the transit layers are funded by the in-transit
          // account, not the asset account; both legs share the transit
          // dimension so they net there without touching the endpoints.
          assert.equal(asset.get(locationDim) ?? "0", "0", `${label}: asset GL at transit`);
          assert.equal(transit.get(locationDim), layers, `${label}: in-transit GL ties transit layers`);
        } else {
          assert.equal(asset.get(locationDim) ?? "0.0000", layers, `${label}: asset GL ties layers`);
          assert.equal(transit.get(locationDim) ?? "0", "0", `${label}: in-transit GL stays off endpoints`);
        }
      }
    };

    await shipTransferOrder(org.orgId, actor, order.id, org.date);
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "0.0000");
    assert.equal((await getOnHand(org.orgId, org.items.fifo, transitId)).value, "100.0000");
    await tie("shipped");

    await receiveTransferOrder(org.orgId, actor, order.id, org.date);
    assert.equal((await getOnHand(org.orgId, org.items.fifo, transitId)).value, "0.0000");
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2)).value, "100.0000");
    await tie("received");

    // One balanced entry per leg: the shipment and the receipt each carry
    // the value movement exactly once, with no companion location reclass.
    const entries = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from journal_entries
       where org_id = ${org.orgId} and origin = 'inventory'
         and memo like ${`Transfer ${order.documentNumber}%`}`)).rows[0]!.count;
    assert.equal(entries, 2, "ship and receive post one entry each");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
